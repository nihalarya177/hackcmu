import { PROCESSING_LIMITS } from '@trip/contracts';
import { createDatabase } from '@trip/db';
import { loadLocalEnvFile, loadWorkerConfig } from '../config/env.js';
import { describeError } from '../domain/errors.js';
import { purgeExpiredRequestLimits } from '../domain/rateLimit.js';
import { recordHeartbeat } from './heartbeat.js';
import { enrichOnce } from './enrich.js';
import { tick } from './scheduler.js';

/**
 * The single persistent background worker.
 *
 * It connects outbound to hosted Postgres and providers, so nothing needs to
 * reach the laptop. Durable work lives in the database: stopping this process
 * pauses processing, and starting it again resumes from committed state rather
 * than from anything held in memory.
 *
 * It maintains the heartbeat, expires rate-limit buckets, and runs one
 * scheduler tick per loop: claiming a due batch under a fresh lease, calling
 * the provider outside every transaction, and committing only while it still
 * owns that lease.
 */
async function main(): Promise<void> {
  await loadLocalEnvFile();
  const config = loadWorkerConfig();

  const database = createDatabase({
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    applicationName: `trip-planner-worker:${config.workerId}`,
    statementTimeoutMs: config.dbStatementTimeoutMs,
  });

  let running = true;
  let lastPurgeAt = 0;

  const stop = (signal: string): void => {
    if (!running) return;
    running = false;
    console.log(`worker stopping (${signal})`);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  console.log(
    `worker ${config.workerId} starting: revision=${config.appRevision} mode=${config.processingMode} ` +
      `llm=${config.llmEnabled ? config.llmModel : 'disabled'} places=${config.placesEnabled ? 'enabled' : 'disabled'}`,
  );

  try {
    while (running) {
      try {
        await recordHeartbeat(database.db, config.workerId, config.appRevision);

        if (Date.now() - lastPurgeAt > 60_000) {
          lastPurgeAt = Date.now();
          await purgeExpiredRequestLimits(database.db);
        }

        await enrichOnce(database.db, {
          apiKey: config.geoapifyApiKey ?? '',
          enabled: config.placesEnabled && config.geoapifyApiKey !== null,
          dailyRequestLimit: config.placesDailyRequestLimit,
        });

        await tick(database.db, {
          workerId: config.workerId,
          appRevision: config.appRevision,
          mode: config.processingMode,
          model: config.llmModel ?? '',
          apiKey: config.geminiApiKey ?? '',
          llmEnabled: config.llmEnabled && config.geminiApiKey !== null && config.llmModel !== null,
          dailyRequestLimit: config.llmDailyRequestLimit,
        });
      } catch (error) {
        // A transient database failure must not kill the worker; the heartbeat
        // simply goes stale and processing reports unavailable until it returns.
        console.error('worker tick failed:', describeError(error));
      }

      // The scheduler polls far faster than the heartbeat interval, because a
      // queued batch should start in seconds rather than in ten.
      await sleep(PROCESSING_LIMITS.schedulerTickMs, () => running);
    }
  } finally {
    // Correctness never depends on this running: leases expire on their own.
    await database.close();
    console.log('worker stopped');
  }
}

function sleep(ms: number, stillRunning: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const step = 250;
    let elapsed = 0;
    const timer = setInterval(() => {
      elapsed += step;
      if (elapsed >= ms || !stillRunning()) {
        clearInterval(timer);
        resolve();
      }
    }, step);
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
