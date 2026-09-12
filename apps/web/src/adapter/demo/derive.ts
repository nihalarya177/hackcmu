import {
  TRAVEL_ESTIMATE,
  TRIP_LIMITS,
  type BudgetStatus,
  type Coordinate,
  type DayPathResource,
  type EventResource,
  type PersonBudgetResource,
  type PlaceResource,
  type SnapshotResponse,
  type UnknownCoverageResource,
  type WarningResource,
} from '@trip/contracts';
import type { DemoState } from './state';

/**
 * Everything the snapshot reports beyond stored rows is computed here, from one
 * consistent view of the simulated state. The live server derives the same
 * fields inside one transaction; deriving rather than storing them is what
 * keeps the demo's calendar, budget panel, warnings and map from disagreeing
 * after an edit.
 *
 * Scope note: every warning here is computed from stored evidence. Travel
 * warnings use the disclosed straight-line estimate, and the two hours
 * warnings fire only for a date whose schedule is actually recorded — an
 * unknown schedule stays unknown rather than being read as open or closed.
 */
export function deriveSnapshot(state: DemoState, serverTime: string): SnapshotResponse {
  const budgets = deriveBudgets(state);
  return {
    trip: state.trip,
    self_person_id: state.active_person_id,
    members: state.members,
    events: [...state.events].sort(compareEvents),
    attendance: state.attendance,
    places: state.places,
    budgets,
    warnings: deriveWarnings(state, budgets),
    unknown_coverage: deriveUnknownCoverage(state),
    day_paths: deriveDayPaths(state),
    actions: state.actions,
    recent_deletions: [...state.deletions]
      .sort((a, b) => b.deleted_at.localeCompare(a.deleted_at))
      .slice(0, TRIP_LIMITS.recentDeletionsInSnapshot),
    has_more_deletions: state.deletions.length > TRIP_LIMITS.recentDeletionsInSnapshot,
    calendar_version: state.calendar_version,
    processing: state.processing,
    server_time: serverTime,
  };
}

export function compareEvents(a: EventResource, b: EventResource): number {
  if (a.local_date !== b.local_date) return a.local_date < b.local_date ? -1 : 1;
  if (a.start_minute !== b.start_minute) return a.start_minute - b.start_minute;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Event ids this person is explicitly `in` for, over live events only. */
export function attendedEvents(state: DemoState, personId: string): EventResource[] {
  const attended = new Set(
    state.attendance
      .filter((row) => row.person_id === personId && row.state === 'in')
      .map((row) => row.event_id),
  );
  return state.events.filter((event) => attended.has(event.id)).sort(compareEvents);
}

function deriveBudgets(state: DemoState): PersonBudgetResource[] {
  return state.members.map((person) => {
    let estimate = 0;
    let confirmed = 0;
    let unknownCount = 0;

    for (const event of attendedEvents(state, person.id)) {
      if (event.price_cents === null) {
        unknownCount += 1;
        continue;
      }
      // Model-sourced prices stay separable from prices a human stands behind.
      if (event.price_source === 'estimate') estimate += event.price_cents;
      else confirmed += event.price_cents;
    }

    const known = estimate + confirmed;
    let status: BudgetStatus;
    if (known > person.budget_cents) status = 'over';
    else if (unknownCount > 0) status = 'unknown';
    else status = 'within';

    return {
      person_id: person.id,
      budget_cents: person.budget_cents,
      known_spend_cents: known,
      estimate_subtotal_cents: estimate,
      confirmed_subtotal_cents: confirmed,
      unknown_price_event_count: unknownCount,
      status,
    };
  });
}

function deriveUnknownCoverage(state: DemoState): UnknownCoverageResource {
  const places = new Map(state.places.map((place) => [place.id, place]));
  const coverage: UnknownCoverageResource = {
    unknown_price_event_ids: [],
    unresolved_place_event_ids: [],
    unknown_hours_event_ids: [],
  };

  for (const event of [...state.events].sort(compareEvents)) {
    if (event.price_cents === null) coverage.unknown_price_event_ids.push(event.id);
    if (event.place_id === null) continue;

    // A placeless event has nothing to resolve, so it is never unknown coverage.
    const place = places.get(event.place_id);
    if (place === undefined || place.coordinate === null) {
      coverage.unresolved_place_event_ids.push(event.id);
    }
    if (place === undefined || !place.hours_days.some((day) => day.date === event.local_date)) {
      coverage.unknown_hours_event_ids.push(event.id);
    }
  }
  return coverage;
}

/**
 * Warnings are recomputed rather than transitioned, so `activated_at_version`
 * is the version that produced them. Deduplicated transition history is a live
 * (P3) concern; the demo only needs the current truth.
 */
function deriveWarnings(state: DemoState, budgets: PersonBudgetResource[]): WarningResource[] {
  const warnings: WarningResource[] = [];
  const places = new Map(state.places.map((place) => [place.id, place]));

  for (const person of state.members) {
    const events = attendedEvents(state, person.id);

    for (let i = 0; i < events.length; i += 1) {
      for (let j = i + 1; j < events.length; j += 1) {
        const a = events[i];
        const b = events[j];
        if (a === undefined || b === undefined) continue;
        const overlap = overlapMinutes(a, b);
        if (overlap === null) continue;
        warnings.push({
          kind: 'double_booking',
          key: `double_booking:${person.id}:${a.id}:${b.id}`,
          person_id: person.id,
          event_ids: [a.id, b.id],
          active: true,
          activated_at_version: state.calendar_version,
          resolved_at_version: null,
          details: { overlap_minutes: overlap },
        });
      }
    }

    // Consecutive stops on one day, with the straight-line estimate as the
    // only claim about travel. Unknown coordinates produce no warning.
    for (const [index, current] of events.entries()) {
      const next = events[index + 1];
      if (next === undefined || next.local_date !== current.local_date) continue;
      const from = coordinateOf(current, places);
      const to = coordinateOf(next, places);
      if (from === null || to === null) continue;

      const distanceKm = haversineKm(from, to);
      const requiredMinutes = Math.ceil((distanceKm / TRAVEL_ESTIMATE.speedKmPerHour) * 60);
      const availableMinutes = next.start_minute - current.end_minute;
      // Overlapping stops are a double booking, not a travel problem. Reporting
      // both for the same pair would double-count one underlying conflict.
      if (availableMinutes < 0) continue;
      if (availableMinutes >= requiredMinutes) continue;

      warnings.push({
        kind: 'insufficient_travel_time',
        key: `insufficient_travel_time:${person.id}:${current.id}:${next.id}`,
        person_id: person.id,
        event_ids: [current.id, next.id],
        active: true,
        activated_at_version: state.calendar_version,
        resolved_at_version: null,
        details: {
          distance_km: Math.round(distanceKm * 100) / 100,
          required_minutes: requiredMinutes,
          available_minutes: availableMinutes,
        },
      });
    }

    const budget = budgets.find((row) => row.person_id === person.id);
    if (budget !== undefined && budget.known_spend_cents > budget.budget_cents) {
      warnings.push({
        kind: 'budget_exceeded',
        key: `budget_exceeded:${person.id}`,
        person_id: person.id,
        event_ids: events.map((event) => event.id),
        active: true,
        activated_at_version: state.calendar_version,
        resolved_at_version: null,
        details: {
          budget_cents: budget.budget_cents,
          known_spend_cents: budget.known_spend_cents,
        },
      });
    }
  }

  // Opening hours are a property of the venue, not of one person's day.
  for (const event of [...state.events].sort(compareEvents)) {
    if (event.place_id === null) continue;
    const place = places.get(event.place_id);
    if (place === undefined) continue;
    const day = place.hours_days.find((entry) => entry.date === event.local_date);
    // No recorded schedule for that exact date means unknown, never open.
    if (day === undefined) continue;

    const base = {
      person_id: null,
      event_ids: [event.id],
      active: true,
      activated_at_version: state.calendar_version,
      resolved_at_version: null,
    };
    if (day.intervals.length === 0) {
      warnings.push({
        ...base,
        kind: 'venue_closed',
        key: `venue_closed:${place.id}:${event.id}`,
        details: { place_id: place.id, provenance: place.hours_provenance },
      });
      continue;
    }
    const inside = day.intervals.some(
      (interval) =>
        event.start_minute >= interval.start_minute && event.end_minute <= interval.end_minute,
    );
    if (!inside) {
      warnings.push({
        ...base,
        kind: 'outside_opening_hours',
        key: `outside_opening_hours:${place.id}:${event.id}`,
        details: {
          place_id: place.id,
          stored_intervals: day.intervals,
          provenance: place.hours_provenance,
        },
      });
    }
  }

  return warnings;
}

/** Half-open intervals on the same date. Touching ends do not overlap. */
function overlapMinutes(a: EventResource, b: EventResource): number | null {
  if (a.local_date !== b.local_date) return null;
  const start = Math.max(a.start_minute, b.start_minute);
  const end = Math.min(a.end_minute, b.end_minute);
  return end > start ? end - start : null;
}

/**
 * Prefix tree over each member's ordered event sequence for one date. Node ids
 * are derived from the event-id path, so an unchanged day yields identical ids
 * across reads and the map does not remount every marker on each poll.
 */
function deriveDayPaths(state: DemoState): DayPathResource[] {
  const places = new Map(state.places.map((place) => [place.id, place]));

  return state.trip.dates.map((date) => {
    const nodes = new Map<
      string,
      {
        id: string;
        parent_id: string | null;
        event_id: string;
        depth: number;
        member_ids: string[];
        coordinate: Coordinate | null;
        unresolved: boolean;
        warning_keys: string[];
      }
    >();
    const edges = new Map<string, { from: string; to: string; member_ids: string[] }>();
    const idle: string[] = [];

    for (const person of state.members) {
      const sequence = attendedEvents(state, person.id).filter(
        (event) => event.local_date === date,
      );
      if (sequence.length === 0) {
        idle.push(person.id);
        continue;
      }

      let parentId: string | null = null;
      const path: string[] = [];
      for (const [depth, event] of sequence.entries()) {
        path.push(event.id);
        const nodeId = path.join('>');
        let node = nodes.get(nodeId);
        if (node === undefined) {
          const coordinate = coordinateOf(event, places);
          node = {
            id: nodeId,
            parent_id: parentId,
            event_id: event.id,
            depth,
            member_ids: [],
            coordinate,
            unresolved: coordinate === null,
            warning_keys: [],
          };
          nodes.set(nodeId, node);
        }
        node.member_ids.push(person.id);

        if (parentId !== null) {
          // Keyed by node ids, so the same leg walked the other way stays a
          // separate edge rather than collapsing into this one.
          const edgeId = `${parentId}=>${nodeId}`;
          const edge = edges.get(edgeId) ?? { from: parentId, to: nodeId, member_ids: [] };
          edge.member_ids.push(person.id);
          edges.set(edgeId, edge);
        }
        parentId = nodeId;
      }
    }

    return {
      date,
      nodes: [...nodes.values()],
      edges: [...edges.values()].map((edge) => {
        const from = nodes.get(edge.from);
        const to = nodes.get(edge.to);
        const distance =
          from?.coordinate != null && to?.coordinate != null
            ? haversineKm(from.coordinate, to.coordinate)
            : null;
        return {
          id: `${edge.from}=>${edge.to}`,
          from_node_id: edge.from,
          to_node_id: edge.to,
          member_ids: edge.member_ids,
          // Never draw a leg across a stop whose position is unknown.
          drawable: distance !== null,
          distance_km: distance,
          required_minutes:
            distance === null ? null : Math.ceil((distance / TRAVEL_ESTIMATE.speedKmPerHour) * 60),
          warning_keys: [],
        };
      }),
      idle_member_ids: idle,
    };
  });
}

function coordinateOf(event: EventResource, places: Map<string, PlaceResource>): Coordinate | null {
  if (event.place_id === null) return null;
  return places.get(event.place_id)?.coordinate ?? null;
}

function haversineKm(a: Coordinate, b: Coordinate): number {
  const radius = 6371;
  const toRad = (degrees: number): number => (degrees * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
}
