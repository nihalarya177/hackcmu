import {
  llmClarification,
  llmOperation,
  type LlmEnvelope,
  type LlmOperation,
  type OperationRejectionCode,
} from '@trip/contracts';
import { AppError } from '../domain/errors.js';

export interface ParsedEnvelope {
  envelope: LlmEnvelope;
  /** Operations discarded before they reached the domain, with the reason. */
  discarded: { op: string; code: OperationRejectionCode }[];
}

/**
 * Turns the provider's flat JSON into the strict contract envelope.
 *
 * Output that is not JSON at all, or is not even shaped like an envelope,
 * fails the attempt: it is never downgraded into an empty successful batch.
 * A single operation that fails its own schema is a different thing — it is
 * discarded with a reason and recorded as a rejection, exactly as a
 * semantically invalid one would be, so one bad proposal cannot throw away
 * the good ones alongside it.
 */
export function parseEnvelope(text: string): ParsedEnvelope {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new AppError('DEPENDENCY_UNAVAILABLE', 'provider_output_not_json');
  }

  const shaped = raw as {
    operations?: Record<string, unknown>[];
    clarifications?: unknown[];
  };

  if (!Array.isArray(shaped.operations) || !Array.isArray(shaped.clarifications)) {
    throw new AppError('DEPENDENCY_UNAVAILABLE', 'provider_output_failed_schema');
  }

  const operations: LlmOperation[] = [];
  const discarded: ParsedEnvelope['discarded'] = [];

  for (const candidate of shaped.operations) {
    const normalized = normalizeOperation(candidate);
    const parsed = llmOperation.safeParse(normalized);
    if (parsed.success) {
      operations.push(parsed.data);
      continue;
    }
    const op = typeof candidate['op'] === 'string' ? candidate['op'] : 'unknown';
    // A null or absent event_id is a reference to nothing — most often a
    // forward reference to an event proposed in the same response.
    const code: OperationRejectionCode =
      (op === 'assign' ||
        op === 'deassign' ||
        op === 'suggest_remove' ||
        op === 'reschedule_event') &&
      (normalized as { event_id?: unknown }).event_id == null
        ? 'forward_reference_to_new_event'
        : 'unknown_reference';
    discarded.push({ op, code });
  }

  const clarifications = shaped.clarifications.flatMap((row) => {
    const parsed = llmClarification.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });

  return { envelope: { operations, clarifications }, discarded };
}

function normalizeOperation(operation: Record<string, unknown>): unknown {
  return ((): unknown => {
    const op = operation['op'];
    const base = {
      op,
      source_message_ids: operation['source_message_ids'],
    };

    switch (op) {
      case 'create_event':
        return {
          ...base,
          label: operation['label'],
          local_date: operation['local_date'],
          start_minute: operation['start_minute'],
          duration_minutes: operation['duration_minutes'],
          estimated_price_cents: operation['estimated_price_cents'] ?? null,
          place: placeRef(operation),
          attendees: operation['attendees'] ?? [],
          revive_tombstone_id: operation['revive_tombstone_id'] ?? null,
        };
      case 'assign':
      case 'deassign':
        return {
          ...base,
          event_id: operation['event_id'],
          attendee: operation['attendee'] ?? firstConsent(operation['attendees']),
        };
      case 'suggest_remove':
        return { ...base, event_id: operation['event_id'], reason: operation['reason'] };
      case 'reschedule_event':
        return {
          ...base,
          event_id: operation['event_id'],
          local_date: operation['local_date'],
          start_minute: operation['start_minute'],
          end_minute: operation['end_minute'],
          movers: operation['movers'] ?? operation['attendees'] ?? [],
        };
      default:
        return base;
    }
  })();
}

function placeRef(operation: Record<string, unknown>): unknown {
  const placeId = operation['place_id'];
  if (typeof placeId === 'string' && placeId !== '') return { kind: 'known', place_id: placeId };
  const query = operation['place_query'];
  if (typeof query === 'string' && query.trim() !== '') return { kind: 'query', query };
  return null;
}

function firstConsent(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}
