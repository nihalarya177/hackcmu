import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  isNewerVersion,
  realtimeMessageRow,
  realtimeTripRow,
} from '@trip/contracts';

describe('decimal-string version comparison', () => {
  it('compares numerically, not lexicographically', () => {
    // The bug this exists to prevent: '9' > '10' is true for strings.
    expect(compareVersions('9', '10')).toBe(-1);
    expect(isNewerVersion('10', '9')).toBe(true);
    expect(isNewerVersion('9', '10')).toBe(false);
  });

  it('handles equality and zero', () => {
    expect(compareVersions('0', '0')).toBe(0);
    expect(isNewerVersion('0', '0')).toBe(false);
  });

  it('stays exact beyond the safe integer range', () => {
    expect(compareVersions('9007199254740993', '9007199254740992')).toBe(1);
    expect(isNewerVersion('9007199254740993', '9007199254740993')).toBe(false);
  });
});

describe('realtime row contracts', () => {
  const tripId = '11111111-1111-4111-8111-111111111111';

  it('normalises the numeric bigints the realtime transport delivers', () => {
    // The realtime client converts int8 with Number(), so these arrive as
    // JavaScript numbers and must be coerced before comparison.
    const parsed = realtimeTripRow.parse({
      id: tripId,
      calendar_version: 12,
      processing_state: 'idle',
      processing_updated_at: '2026-10-02T10:00:00Z',
      last_user_msg_id: 44,
      lease_token: null,
    });
    expect(parsed.calendar_version).toBe('12');
    expect(parsed.last_user_msg_id).toBe('44');
    expect(isNewerVersion(parsed.calendar_version, '9')).toBe(true);
  });

  it('accepts string bigints unchanged', () => {
    const parsed = realtimeMessageRow.parse({
      id: '9007199254740993',
      trip_id: tripId,
      kind: 'user',
      author_person_id: '22222222-2222-4222-8222-222222222222',
      body: 'hello',
      client_nonce: '33333333-3333-4333-8333-333333333333',
      created_at: '2026-10-02T10:00:00Z',
    });
    expect(parsed.id).toBe('9007199254740993');
  });

  it('never reports the derived unavailable state, which no row can carry', () => {
    expect(
      realtimeTripRow.safeParse({
        id: tripId,
        calendar_version: 1,
        processing_state: 'unavailable',
        processing_updated_at: '2026-10-02T10:00:00Z',
        last_user_msg_id: 1,
      }).success,
    ).toBe(false);
  });
});
