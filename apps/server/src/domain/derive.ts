import {
  TRAVEL_ESTIMATE,
  type AttendanceResource,
  type BudgetStatus,
  type Coordinate,
  type DayPathResource,
  type EventResource,
  type PersonBudgetResource,
  type PersonResource,
  type PlaceResource,
  type UnknownCoverageResource,
  type WarningResource,
} from '@trip/contracts';

/**
 * Everything the snapshot reports beyond stored rows.
 *
 * These are pure functions over one consistent read, so the HTTP commands and
 * the extraction batches in M2 compute the same answers from the same inputs
 * rather than each maintaining their own idea of what a conflict is.
 */
export interface DerivedInput {
  members: PersonResource[];
  /** Live events only. Deleted events never contribute to derived state. */
  events: EventResource[];
  attendance: AttendanceResource[];
  places: PlaceResource[];
}

export function attendedEventsOf(input: DerivedInput, personId: string): EventResource[] {
  const going = new Set(
    input.attendance
      .filter((row) => row.person_id === personId && row.state === 'in')
      .map((row) => row.event_id),
  );
  return input.events.filter((event) => going.has(event.id)).sort(compareEvents);
}

export function compareEvents(a: EventResource, b: EventResource): number {
  if (a.local_date !== b.local_date) return a.local_date < b.local_date ? -1 : 1;
  if (a.start_minute !== b.start_minute) return a.start_minute - b.start_minute;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Integer cents throughout. Estimates stay separable from prices a person
 * stands behind, and an unknown price is counted, never guessed at zero.
 */
export function deriveBudgets(input: DerivedInput): PersonBudgetResource[] {
  return input.members.map((person) => {
    let estimate = 0;
    let confirmed = 0;
    let unknown = 0;

    for (const event of attendedEventsOf(input, person.id)) {
      if (event.price_cents === null) {
        unknown += 1;
        continue;
      }
      if (event.price_source === 'estimate') estimate += event.price_cents;
      else confirmed += event.price_cents;
    }

    const known = estimate + confirmed;
    let status: BudgetStatus;
    if (known > person.budget_cents) status = 'over';
    else if (unknown > 0) status = 'unknown';
    else status = 'within';

    return {
      person_id: person.id,
      budget_cents: person.budget_cents,
      known_spend_cents: known,
      estimate_subtotal_cents: estimate,
      confirmed_subtotal_cents: confirmed,
      unknown_price_event_count: unknown,
      status,
    };
  });
}

/**
 * What the planner does not know. An event with no venue at all has nothing to
 * resolve, so it is never unresolved coverage; only events that name a place
 * whose position or exact-date schedule is missing appear here.
 */
export function deriveUnknownCoverage(input: DerivedInput): UnknownCoverageResource {
  const places = new Map(input.places.map((place) => [place.id, place]));
  const coverage: UnknownCoverageResource = {
    unknown_price_event_ids: [],
    unresolved_place_event_ids: [],
    unknown_hours_event_ids: [],
  };

  for (const event of [...input.events].sort(compareEvents)) {
    if (event.price_cents === null) coverage.unknown_price_event_ids.push(event.id);
    if (event.place_id === null) continue;

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

/** Half-open intervals on one date. Touching ends do not overlap. */
export function overlapMinutes(a: EventResource, b: EventResource): number | null {
  if (a.local_date !== b.local_date) return null;
  const start = Math.max(a.start_minute, b.start_minute);
  const end = Math.min(a.end_minute, b.end_minute);
  return end > start ? end - start : null;
}

/**
 * How many live events run at the same moment as `candidate`, counting itself.
 * The cap is global to the trip, not per person: three simultaneous events is
 * the most the calendar is allowed to represent.
 */
export function maxSimultaneous(events: EventResource[], candidate: EventResource): number {
  const sameDay = events.filter(
    (event) => event.id !== candidate.id && event.local_date === candidate.local_date,
  );
  // The peak can only occur at a start boundary of one of the intervals.
  const boundaries = [candidate.start_minute, ...sameDay.map((event) => event.start_minute)];
  let peak = 0;
  for (const at of boundaries) {
    if (at < candidate.start_minute || at >= candidate.end_minute) continue;
    const running = sameDay.filter(
      (event) => event.start_minute <= at && at < event.end_minute,
    ).length;
    peak = Math.max(peak, running + 1);
  }
  return peak;
}

export function haversineKm(a: Coordinate, b: Coordinate): number {
  const radius = 6371;
  const toRad = (degrees: number): number => (degrees * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A disclosed straight-line estimate at a fixed speed. Not a route. */
export function travelMinutes(distanceKm: number): number {
  return Math.ceil((distanceKm / TRAVEL_ESTIMATE.speedKmPerHour) * 60);
}

function coordinateOf(event: EventResource, places: Map<string, PlaceResource>): Coordinate | null {
  if (event.place_id === null) return null;
  return places.get(event.place_id)?.coordinate ?? null;
}

/**
 * The warnings the current state justifies, keyed stably so the persistence
 * layer can tell an unchanged warning from a new one.
 *
 * Every one is computed from stored evidence. An unknown schedule stays
 * unknown: it is never read as open, and never as closed.
 */
export function deriveWarnings(input: DerivedInput, atVersion: string): WarningResource[] {
  const warnings: WarningResource[] = [];
  const places = new Map(input.places.map((place) => [place.id, place]));
  const budgets = deriveBudgets(input);

  for (const person of input.members) {
    const events = attendedEventsOf(input, person.id);

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
          activated_at_version: atVersion,
          resolved_at_version: null,
          details: { overlap_minutes: overlap },
        });
      }
    }

    for (const [index, current] of events.entries()) {
      const next = events[index + 1];
      if (next === undefined || next.local_date !== current.local_date) continue;
      const from = coordinateOf(current, places);
      const to = coordinateOf(next, places);
      if (from === null || to === null) continue;

      const available = next.start_minute - current.end_minute;
      // Overlapping stops are a double booking, not a travel problem; reporting
      // both would double-count one underlying conflict.
      if (available < 0) continue;
      const distanceKm = haversineKm(from, to);
      const required = travelMinutes(distanceKm);
      if (available >= required) continue;

      warnings.push({
        kind: 'insufficient_travel_time',
        key: `insufficient_travel_time:${person.id}:${current.id}:${next.id}`,
        person_id: person.id,
        event_ids: [current.id, next.id],
        active: true,
        activated_at_version: atVersion,
        resolved_at_version: null,
        details: {
          distance_km: Math.round(distanceKm * 100) / 100,
          required_minutes: required,
          available_minutes: available,
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
        activated_at_version: atVersion,
        resolved_at_version: null,
        details: {
          budget_cents: budget.budget_cents,
          known_spend_cents: budget.known_spend_cents,
        },
      });
    }
  }

  // Opening hours belong to the venue, not to one person's day.
  for (const event of [...input.events].sort(compareEvents)) {
    if (event.place_id === null) continue;
    const place = places.get(event.place_id);
    if (place === undefined) continue;
    const day = place.hours_days.find((entry) => entry.date === event.local_date);
    if (day === undefined) continue;

    const base = {
      person_id: null,
      event_ids: [event.id],
      active: true,
      activated_at_version: atVersion,
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

/**
 * Prefix tree over each member's ordered event sequence for one date.
 *
 * Node ids are derived from the event-id path, so an unchanged day always
 * yields the same ids and map layers are not remounted on every poll. Two
 * nodes may share an event id where separate histories reconverge; the map
 * draws one marker per event id, and the tree keeps the histories.
 */
export function deriveDayPaths(input: DerivedInput, dates: string[]): DayPathResource[] {
  const places = new Map(input.places.map((place) => [place.id, place]));

  return dates.map((date) => {
    const nodes = new Map<string, DayPathResource['nodes'][number]>();
    const edges = new Map<string, { from: string; to: string; member_ids: string[] }>();
    const idle: string[] = [];

    for (const person of input.members) {
      const sequence = attendedEventsOf(input, person.id).filter(
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
            ? Math.round(haversineKm(from.coordinate, to.coordinate) * 100) / 100
            : null;
        return {
          id: `${edge.from}=>${edge.to}`,
          from_node_id: edge.from,
          to_node_id: edge.to,
          member_ids: edge.member_ids,
          // Never draw a leg across a stop whose position is unknown.
          drawable: distance !== null,
          distance_km: distance,
          required_minutes: distance === null ? null : travelMinutes(distance),
          warning_keys: [],
        };
      }),
      idle_member_ids: idle,
    };
  });
}

/** Annotates nodes and edges with the warnings that concern their events. */
export function attachWarningKeys(
  dayPaths: DayPathResource[],
  warnings: WarningResource[],
): DayPathResource[] {
  return dayPaths.map((day) => ({
    ...day,
    nodes: day.nodes.map((node) => ({
      ...node,
      warning_keys: warnings
        .filter((warning) => warning.active && warning.event_ids.includes(node.event_id))
        .map((warning) => warning.key),
    })),
    edges: day.edges.map((edge) => {
      const from = day.nodes.find((node) => node.id === edge.from_node_id)?.event_id;
      const to = day.nodes.find((node) => node.id === edge.to_node_id)?.event_id;
      return {
        ...edge,
        warning_keys: warnings
          .filter(
            (warning) =>
              warning.active &&
              from !== undefined &&
              to !== undefined &&
              warning.event_ids.includes(from) &&
              warning.event_ids.includes(to),
          )
          .map((warning) => warning.key),
      };
    }),
  }));
}
