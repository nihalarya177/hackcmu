import { z } from 'zod';
import { bigintString } from './primitives.js';

/**
 * Stable machine-readable error codes. Clients branch on `code`, never on the
 * human-readable message. No raw SQL or provider text is ever surfaced.
 */
export const ERROR_CODES = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_SELF: 403,
  NOT_FOUND: 404,
  INVITE_INVALID: 404,
  STALE_VERSION: 409,
  IDEMPOTENCY_KEY_CONFLICT: 409,
  TRIP_FULL: 409,
  CAPACITY_EXCEEDED: 409,
  ACTION_CONFLICT: 409,
  INVITE_UNUSABLE: 409,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
  CONSENT_REQUIRED: 422,
  RATE_LIMITED: 429,
  DEPENDENCY_UNAVAILABLE: 503,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export const errorCode = z.enum(Object.keys(ERROR_CODES) as [ErrorCode, ...ErrorCode[]]);

export function statusForErrorCode(code: ErrorCode): number {
  return ERROR_CODES[code];
}

export const fieldError = z.strictObject({
  path: z.string(),
  message: z.string(),
});

export const apiError = z.strictObject({
  error: z.strictObject({
    code: errorCode,
    message: z.string(),
    request_id: z.string(),
    field_errors: z.array(fieldError).optional(),
    /** Present on 409 STALE_VERSION so the client can reconcile without a refetch race. */
    current_calendar_version: bigintString.optional(),
    /** Present on 429 so the client can back off deliberately. */
    retry_after_seconds: z.int().min(0).optional(),
  }),
});

export type ApiError = z.infer<typeof apiError>;
export type FieldError = z.infer<typeof fieldError>;
