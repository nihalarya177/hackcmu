import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { DayPathResource, SnapshotResponse } from '@trip/contracts';
import { clock, dayLabel } from './format';

/**
 * Leaflet over ordinary OpenStreetMap raster tiles, drawing the same
 * server-derived day paths the calendar reads. One marker per stop, one line
 * per leg, coloured by who is walking it.
 *
 * Nothing is drawn across a stop with no coordinates: an unresolved venue is
 * listed in words instead of being guessed onto the map.
 */
export function MapPanel({ snapshot }: { snapshot: SnapshotResponse }): React.ReactElement {
  const dates = snapshot.trip.dates;
  const [date, setDate] = useState(dates[0] ?? snapshot.trip.start_date);
  const day = snapshot.day_paths.find((entry) => entry.date === date);
  const [tilesFailed, setTilesFailed] = useState(false);

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap gap-1">
        {dates.map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setDate(value)}
            aria-pressed={value === date}
            className={`rounded-full border px-3 py-1 text-xs ${
              value === date
                ? 'border-slate-900 bg-slate-900 text-white'
                : 'border-slate-300 bg-white text-slate-700'
            }`}
          >
            {dayLabel(value)}
          </button>
        ))}
      </div>

      <LeafletCanvas snapshot={snapshot} day={day} onTileError={() => setTilesFailed(true)} />

      {tilesFailed && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Map tiles could not be loaded. The stops below are still correct.
        </p>
      )}

      <DayPlan snapshot={snapshot} day={day} />
    </section>
  );
}

function LeafletCanvas({
  snapshot,
  day,
  onTileError,
}: {
  snapshot: SnapshotResponse;
  day: DayPathResource | undefined;
  onTileError: () => void;
}): React.ReactElement {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const drawn = useRef<L.LayerGroup | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (container.current === null || map.current !== null) return;
    const instance = L.map(container.current, { attributionControl: true }).setView(
      [snapshot.trip.destination_center.lat, snapshot.trip.destination_center.lon],
      13,
    );
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      // Attribution is a condition of using these tiles, not decoration.
      attribution: '© OpenStreetMap contributors',
    })
      .on('tileerror', onTileError)
      .addTo(instance);
    drawn.current = L.layerGroup().addTo(instance);
    map.current = instance;

    // The panel is mounted while its tab is hidden, so the container starts at
    // zero size and Leaflet lays the map out against nothing. Re-measure
    // whenever the box actually gets a size.
    const observer = new ResizeObserver((entries) => {
      instance.invalidateSize();
      const box = entries[0]?.contentRect;
      if (box !== undefined && box.height > 0) setVisible(true);
    });
    observer.observe(container.current);

    return () => {
      observer.disconnect();
      instance.remove();
      map.current = null;
      drawn.current = null;
    };
  }, [snapshot.trip.destination_center.lat, snapshot.trip.destination_center.lon, onTileError]);

  useEffect(() => {
    const layer = drawn.current;
    const instance = map.current;
    if (layer === null || instance === null) return;
    layer.clearLayers();

    const colors = new Map(snapshot.members.map((person) => [person.id, person.color]));
    const nodes = new Map((day?.nodes ?? []).map((node) => [node.id, node]));
    const points: L.LatLngExpression[] = [];

    for (const edge of day?.edges ?? []) {
      if (!edge.drawable) continue;
      const from = nodes.get(edge.from_node_id)?.coordinate;
      const to = nodes.get(edge.to_node_id)?.coordinate;
      if (from == null || to == null) continue;
      L.polyline(
        [
          [from.lat, from.lon],
          [to.lat, to.lon],
        ],
        {
          color: colors.get(edge.member_ids[0] ?? '') ?? '#64748b',
          weight: 3,
          opacity: 0.75,
        },
      ).addTo(layer);
    }

    // One marker per event, not per node: separate histories that reconverge on
    // the same stop share an event id, and stacking two markers on one point
    // would misread as two visits.
    for (const stop of stopsForDay(day)) {
      if (stop.coordinate === null) continue;
      const tint = colors.get(stop.member_ids[0] ?? '') ?? '#64748b';
      L.circleMarker([stop.coordinate.lat, stop.coordinate.lon], {
        radius: 8,
        color: '#ffffff',
        weight: 2,
        fillColor: tint,
        fillOpacity: 1,
      })
        .bindTooltip(labelFor(snapshot, stop.event_id), { direction: 'top' })
        .addTo(layer);
      points.push([stop.coordinate.lat, stop.coordinate.lon]);
    }

    // Fitting against a zero-size container throws; the observer above will
    // re-run this once the panel is actually on screen.
    if (points.length > 0 && instance.getContainer().clientHeight > 0) {
      instance.fitBounds(L.latLngBounds(points).pad(0.35), { maxZoom: 15 });
    }
  }, [snapshot, day, visible]);

  return (
    <div
      ref={container}
      role="application"
      aria-label="Map of the day's stops"
      className="h-64 w-full shrink-0 overflow-hidden rounded-lg border border-slate-200 md:h-80"
    />
  );
}

/**
 * The day's distinct stops. The prefix tree keeps one node per history, so a
 * stop two groups both attend appears more than once in `nodes`; here they
 * merge back into one entry carrying everyone who is going.
 */
function stopsForDay(day: DayPathResource | undefined): {
  event_id: string;
  member_ids: string[];
  coordinate: { lat: number; lon: number } | null;
  unresolved: boolean;
  depth: number;
}[] {
  const stops = new Map<string, ReturnType<typeof stopsForDay>[number]>();
  for (const node of day?.nodes ?? []) {
    const existing = stops.get(node.event_id);
    if (existing === undefined) {
      stops.set(node.event_id, {
        event_id: node.event_id,
        member_ids: [...node.member_ids],
        coordinate: node.coordinate,
        unresolved: node.unresolved,
        depth: node.depth,
      });
      continue;
    }
    for (const id of node.member_ids) {
      if (!existing.member_ids.includes(id)) existing.member_ids.push(id);
    }
    existing.depth = Math.min(existing.depth, node.depth);
  }
  return [...stops.values()];
}

function DayPlan({
  snapshot,
  day,
}: {
  snapshot: SnapshotResponse;
  day: DayPathResource | undefined;
}): React.ReactElement {
  const names = new Map(snapshot.members.map((person) => [person.id, person]));
  const starts = new Map(snapshot.events.map((event) => [event.id, event.start_minute]));
  // Ordered by when they actually happen, which is comparable across branches
  // in a way that tree depth is not.
  const nodes = stopsForDay(day).sort(
    (a, b) => (starts.get(a.event_id) ?? 0) - (starts.get(b.event_id) ?? 0),
  );

  if (nodes.length === 0) {
    return (
      <p className="rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-600">
        Nothing is planned for this day.
      </p>
    );
  }

  return (
    <ol aria-label="Stops on this day" className="grid gap-1 overflow-y-auto text-sm">
      {nodes.map((node) => {
        const event = snapshot.events.find((row) => row.id === node.event_id);
        return (
          <li
            key={node.event_id}
            className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2"
          >
            <span className="min-w-0">
              <span className="block truncate text-slate-800">
                {event?.label ?? 'a deleted event'}
              </span>
              <span className="text-xs text-slate-500">
                {event === undefined ? '' : clock(event.start_minute)}
                {node.unresolved && ' · no location yet'}
              </span>
            </span>
            <span className="flex shrink-0 gap-1">
              {node.member_ids.map((id) => (
                <span
                  key={id}
                  title={names.get(id)?.display_name}
                  aria-label={names.get(id)?.display_name}
                  className="inline-block size-2.5 rounded-full"
                  style={{ backgroundColor: names.get(id)?.color }}
                />
              ))}
            </span>
          </li>
        );
      })}
      {(day?.idle_member_ids.length ?? 0) > 0 && (
        <li className="px-1 text-xs text-slate-500">
          Nothing planned for{' '}
          {(day?.idle_member_ids ?? [])
            .map((id) => names.get(id)?.display_name ?? 'someone')
            .join(', ')}
          .
        </li>
      )}
    </ol>
  );
}

function labelFor(snapshot: SnapshotResponse, eventId: string): string {
  return snapshot.events.find((event) => event.id === eventId)?.label ?? 'Deleted event';
}
