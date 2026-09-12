import type { ErrorCode, FieldError } from '@trip/contracts';

export interface AppErrorOptions {
  fieldErrors?: FieldError[];
  currentCalendarVersion?: bigint;
  retryAfterSeconds?: number;
  cause?: unknown;
}

/**
 * A failure that is safe to describe to the caller.
 *
 * Anything not raised as an AppError is treated as internal: it is logged with
 * full detail server-side and reported as INTERNAL with only a request id, so
 * SQL text, provider responses and credentials cannot escape through an error
 * body.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly fieldErrors: FieldError[] | undefined;
  readonly currentCalendarVersion: bigint | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.fieldErrors = options.fieldErrors;
    this.currentCalendarVersion = options.currentCalendarVersion;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export const notFound = (what: string): AppError => new AppError('NOT_FOUND', `${what} not found`);

export const forbidden = (message: string): AppError => new AppError('FORBIDDEN', message);

export const staleVersion = (current: bigint): AppError =>
  new AppError('STALE_VERSION', 'The plan changed since this edit was prepared', {
    currentCalendarVersion: current,
  });

interface DriverErrorShape {
  code?: unknown;
  constraint?: unknown;
  cause?: unknown;
}

/**
 * Finds the underlying driver error.
 *
 * The query builder wraps driver errors, so the SQLSTATE code lives on a cause
 * rather than on the thrown object. Checking only the outer error silently
 * turns an expected unique violation into an unhandled 500.
 */
function driverError(error: unknown): DriverErrorShape | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) return null;
    const candidate = current as DriverErrorShape;
    if (typeof candidate.code === 'string') return candidate;
    current = candidate.cause;
  }
  return null;
}

/** Postgres unique violation, wrapped or not. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const driver = driverError(error);
  if (driver === null || driver.code !== '23505') return false;
  if (constraint === undefined) return true;
  return driver.constraint === constraint;
}

/**
 * A log-safe description of an unexpected error.
 *
 * Query builders put bound parameters into the error message, and those
 * parameters can include an invite token or a stored receipt payload. Only the
 * statement classification is kept; the values are dropped.
 */
export function describeError(error: unknown): Record<string, string> {
  const driver = driverError(error);
  const described: Record<string, string> = {
    name: error instanceof Error ? error.name : typeof error,
    message:
      error instanceof Error
        ? (error.message.split('\nparams:')[0]?.slice(0, 300) ?? '')
        : String(error).slice(0, 300),
  };
  if (typeof driver?.code === 'string') described['sqlstate'] = driver.code;
  if (typeof driver?.constraint === 'string') described['constraint'] = driver.constraint;
  return described;
}
