import { describe, expect, it } from 'vitest';
import {
  PERSON_COLORS,
  TRIP_LIMITS,
  bigintString,
  createEventRequest,
  createMessageRequest,
  listMessagesQuery,
  llmEnvelope,
  personColor,
  patchEventRequest,
  snapshotResponse,
} from '@trip/contracts';

describe('shared primitives', () => {
  it('serializes bigint cursors as decimal strings, never numbers', () => {
    expect(bigintString.safeParse('9007199254740993').success).toBe(true);
    expect(bigintString.safeParse('01').success).toBe(false);
    expect(bigintString.safeParse('-1').success).toBe(false);
    expect(bigintString.safeParse(12).success).toBe(false);
  });

  it('exposes exactly one immutable colour per member slot', () => {
    expect(PERSON_COLORS).toHaveLength(TRIP_LIMITS.maxMembers);
    expect(new Set(PERSON_COLORS).size).toBe(TRIP_LIMITS.maxMembers);
    expect(personColor(0)).toBe(PERSON_COLORS[0]);
    expect(() => personColor(12)).toThrow();
  });
});

describe('request contracts', () => {
  const envelope = {
    idempotency_key: 'abcdefgh-1234',
    expected_calendar_version: '3',
  };

  it('requires price value and provenance to move together', () => {
    const base = {
      ...envelope,
      label: 'Warhol Museum',
      local_date: '2026-10-02',
      start_minute: 600,
      end_minute: 690,
    };
    expect(
      createEventRequest.safeParse({ ...base, price_cents: 2000, price_source: 'estimate' })
        .success,
    ).toBe(true);
    expect(
      createEventRequest.safeParse({ ...base, price_cents: null, price_source: null }).success,
    ).toBe(true);
    expect(
      createEventRequest.safeParse({ ...base, price_cents: 2000, price_source: null }).success,
    ).toBe(false);
    expect(
      createEventRequest.safeParse({ ...base, price_cents: null, price_source: 'estimate' })
        .success,
    ).toBe(false);
  });

  it('treats zero as an explicit free price, not as unknown', () => {
    const parsed = createEventRequest.safeParse({
      ...envelope,
      label: 'Free walking tour',
      local_date: '2026-10-02',
      start_minute: 600,
      end_minute: 690,
      price_cents: 0,
      price_source: 'confirmed',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a partial price edit', () => {
    expect(patchEventRequest.safeParse({ ...envelope, price_cents: 500 }).success).toBe(false);
    expect(
      patchEventRequest.safeParse({ ...envelope, price_cents: 500, price_source: 'estimate' })
        .success,
    ).toBe(true);
  });

  it('rejects unknown fields rather than silently dropping them', () => {
    expect(
      createMessageRequest.safeParse({
        body: 'hi',
        client_nonce: '0d1f6bd4-95b0-4bbb-9c53-1b7f3a0a5f11',
        person_id: 'someone-else',
      }).success,
    ).toBe(false);
  });

  it('bounds message length at the configured limit', () => {
    const nonce = '0d1f6bd4-95b0-4bbb-9c53-1b7f3a0a5f11';
    expect(
      createMessageRequest.safeParse({
        body: 'x'.repeat(TRIP_LIMITS.maxMessageChars),
        client_nonce: nonce,
      }).success,
    ).toBe(true);
    expect(
      createMessageRequest.safeParse({
        body: 'x'.repeat(TRIP_LIMITS.maxMessageChars + 1),
        client_nonce: nonce,
      }).success,
    ).toBe(false);
  });

  it('forbids paginating in both directions at once', () => {
    expect(listMessagesQuery.safeParse({ before_id: '10' }).success).toBe(true);
    expect(listMessagesQuery.safeParse({ after_id: '10' }).success).toBe(true);
    expect(listMessagesQuery.safeParse({ before_id: '10', after_id: '20' }).success).toBe(false);
  });

  it('caps a message page at the documented maximum', () => {
    expect(listMessagesQuery.safeParse({ limit: TRIP_LIMITS.messagePageMax }).success).toBe(true);
    expect(listMessagesQuery.safeParse({ limit: TRIP_LIMITS.messagePageMax + 1 }).success).toBe(
      false,
    );
  });
});

describe('model operation envelope', () => {
  const evidence = (personId: string) => ({
    person_id: personId,
    evidence_message_ids: ['12'],
  });
  const personA = '11111111-1111-4111-8111-111111111111';
  const personB = '22222222-2222-4222-8222-222222222222';

  it('requires two distinct consenting attendees to create an event', () => {
    const create = {
      op: 'create_event',
      source_message_ids: ['12'],
      label: 'Dinner',
      local_date: '2026-10-02',
      start_minute: 1140,
      duration_minutes: 90,
      place: null,
      estimated_price_cents: null,
      revive_tombstone_id: null,
    };
    expect(
      llmEnvelope.safeParse({
        operations: [{ ...create, attendees: [evidence(personA), evidence(personB)] }],
        clarifications: [],
      }).success,
    ).toBe(true);
    expect(
      llmEnvelope.safeParse({
        operations: [{ ...create, attendees: [evidence(personA)] }],
        clarifications: [],
      }).success,
    ).toBe(false);
  });

  it('rejects an operation the model invented a name for', () => {
    expect(
      llmEnvelope.safeParse({
        operations: [{ op: 'delete_event', source_message_ids: ['12'], event_id: personA }],
        clarifications: [],
      }).success,
    ).toBe(false);
  });

  it('requires every operation to cite at least one source message', () => {
    expect(
      llmEnvelope.safeParse({
        operations: [
          { op: 'suggest_remove', source_message_ids: [], event_id: personA, reason: 'nope' },
        ],
        clarifications: [],
      }).success,
    ).toBe(false);
  });
});

describe('snapshot contract', () => {
  it('rejects a snapshot that omits processing status', () => {
    expect(snapshotResponse.safeParse({ trip: {}, members: [] }).success).toBe(false);
  });
});
