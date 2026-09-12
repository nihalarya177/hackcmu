import type { ApiError, ErrorCode } from '@trip/contracts';

/**
 * A failure the UI can branch on without parsing prose.
 *
 * It lives apart from `api.ts` so the demo adapter can raise the same
 * contract-shaped failures without importing the fetch client, its
 * configuration or the Supabase SDK.
 */
export class ApiRequestError extends Error {
  readonly code: ErrorCode | 'NETWORK' | 'MALFORMED_RESPONSE';
  readonly status: number;
  readonly requestId: string | null;
  readonly currentCalendarVersion: string | null;
  readonly retryAfterSeconds: number | null;
  readonly fieldErrors: ApiError['error']['field_errors'];

  constructor(
    code: ErrorCode | 'NETWORK' | 'MALFORMED_RESPONSE',
    message: string,
    options: {
      status?: number;
      requestId?: string | null;
      currentCalendarVersion?: string | null;
      retryAfterSeconds?: number | null;
      fieldErrors?: ApiError['error']['field_errors'];
    } = {},
  ) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = code;
    this.status = options.status ?? 0;
    this.requestId = options.requestId ?? null;
    this.currentCalendarVersion = options.currentCalendarVersion ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.fieldErrors = options.fieldErrors;
  }
}

/**
 * The operation is not available in this mode at all.
 *
 * Distinct from `ApiRequestError` on purpose: it means "this build cannot do
 * that", not "the attempt failed". The UI hides or disables the control rather
 * than offering a retry, and neither adapter ever answers it with fixtures.
 */
export class UnsupportedOperationError extends Error {
  readonly mode: 'demo' | 'live';
  readonly operation: string;

  constructor(mode: 'demo' | 'live', operation: string, detail?: string) {
    super(detail ?? `${operation} is not available in ${mode} mode`);
    this.name = 'UnsupportedOperationError';
    this.mode = mode;
    this.operation = operation;
  }
}
