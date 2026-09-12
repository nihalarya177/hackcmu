import { loadLocalEnvFile, loadHttpConfig } from '../config/env.js';
import { createHttpServer } from './server.js';

/** Local development entry point. Vite proxies /api here. */
async function main(): Promise<void> {
  await loadLocalEnvFile();
  const config = loadHttpConfig();
  const { app, database } = await createHttpServer(config);

  const shutdown = async (): Promise<void> => {
    await app.close();
    await database.close();
  };
  process.on('SIGINT', () => void shutdown().then(() => process.exit(0)));
  process.on('SIGTERM', () => void shutdown().then(() => process.exit(0)));

  await app.listen({ port: config.port, host: '127.0.0.1' });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
