import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  generateInviteToken,
  payloadHash,
  scopeHash,
} from '../../apps/server/src/domain/hash.js';

describe('canonical payload hashing', () => {
  it('ignores key order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(payloadHash({ b: 1, a: 2 }).equals(payloadHash({ a: 2, b: 1 }))).toBe(true);
  });

  it('preserves array order, which is meaningful', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('distinguishes different values under the same key', () => {
    expect(payloadHash({ budget_cents: 100 }).equals(payloadHash({ budget_cents: 101 }))).toBe(
      false,
    );
  });

  it('treats an absent key and an explicit undefined as the same input', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it('distinguishes null from absent', () => {
    expect(canonicalJson({ a: 1, b: null })).not.toBe(canonicalJson({ a: 1 }));
  });
});

describe('invite tokens', () => {
  it('carries at least 128 bits of entropy in a URL-safe encoding', () => {
    const token = generateInviteToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    // base64url of 24 random bytes: 192 bits.
    expect(token.length).toBeGreaterThanOrEqual(22);
  });

  it('does not repeat', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateInviteToken()));
    expect(tokens.size).toBe(200);
  });
});

describe('rate-limit scopes', () => {
  it('does not collide when parts are re-split differently', () => {
    expect(scopeHash('ab', 'c').equals(scopeHash('a', 'bc'))).toBe(false);
  });

  it('is stable for the same scope', () => {
    expect(
      scopeHash('message_send', 'trip', 'user').equals(scopeHash('message_send', 'trip', 'user')),
    ).toBe(true);
  });
});
