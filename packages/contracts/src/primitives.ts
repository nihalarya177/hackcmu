import { z } from 'zod';

/**
 * Database bigint cursors and versions cross the wire as decimal strings.
 * JavaScript numbers cannot represent the full bigint range exactly.
 */
const DECIMAL_BIGINT = /^(0|[1-9][0-9]{0,18})$/;

export const bigintString = z.string().regex(DECIMAL_BIGINT, 'must be a decimal integer string');

/**
 * Compares two decimal-string versions or cursors numerically.
 *
 * Never compare these with the relational operators: they are strings, so
 * `'9' > '10'` is true. A trip reaches version 10 within a minute of use, and a
 * lexicographic comparison would silently let a stale response overwrite newer
 * cached state at that exact point.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const left = BigInt(a);
  const right = BigInt(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** True when `candidate` describes strictly newer state than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

export const uuid = z.uuid();

export const isoTimestamp = z.iso.datetime({ offset: true });

/** Calendar dates are local to the trip timezone; never a UTC instant. */
export const localDate = z.iso.date();

/** Minute offset from local midnight. 1440 is end-of-day only. */
export const minuteOfDay = z.int().min(0).max(1440);

export const timezoneName = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'must be a valid IANA timezone');

/** Integer cents. Money is never a float anywhere in this system. */
export const MIN_CENTS = 0;
export const MAX_CENTS = 100_000_000;
export const cents = z.int().min(MIN_CENTS).max(MAX_CENTS);

export const latitude = z.number().finite().min(-90).max(90);
export const longitude = z.number().finite().min(-180).max(180);

export const coordinate = z.strictObject({
  lat: latitude,
  lon: longitude,
});
export type Coordinate = z.infer<typeof coordinate>;

export const displayName = z.string().trim().min(1).max(60);
export const tripName = z.string().trim().min(1).max(80);
export const groupName = z.string().trim().min(1).max(80);
export const eventLabel = z.string().trim().min(1).max(120);
export const placeLabel = z.string().trim().min(1).max(160);
export const locationQuery = z.string().trim().min(1).max(160);

/** Client-generated deduplication token for optimistic chat sends. */
export const clientNonce = uuid;

/** Caller-generated key scoped to (auth user, command). */
export const idempotencyKey = z.string().trim().min(8).max(200);

export const inviteToken = z
  .string()
  .trim()
  .min(22)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, 'must be URL-safe base64url');

/** Opaque server-issued reference to a cached place-search candidate. */
export const candidateRef = z.string().trim().min(8).max(256);
