import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Stable JSON encoding so the same logical payload always hashes identically
 * regardless of key order. Used to detect an idempotency key reused with
 * different input, which is an error rather than a replay.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortValue(v)]));
  }
  return value;
}

export function payloadHash(value: unknown): Buffer {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest();
}

export function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function constantTimeEquals(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** At least 128 bits of entropy, URL-safe, suitable for an invite fragment. */
export function generateInviteToken(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Hashed scope for rate-limit counters, so no raw IP address or session token
 * is ever stored. Parts are length-prefixed to keep the join unambiguous.
 */
export function scopeHash(...parts: string[]): Buffer {
  const encoded = parts.map((part) => `${part.length}:${part}`).join('/');
  return createHash('sha256').update(encoded, 'utf8').digest();
}
