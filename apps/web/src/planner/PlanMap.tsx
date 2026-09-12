import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { DayPathResource, SnapshotResponse } from '@trip/contracts';
import { clock, shortDay } from './format';

/**
 * Where the day actually goes, on a real map.
 *
 * One marker per event, drawn from the server's day paths so the calendar and
 * the map cannot disagree. Nothing is drawn across a stop whose position is
 * unknown; it is listed in words instead of being guessed onto the map.
 */
export function PlanMap({
  snapshot,
  onOpenEvent,
}: {
  snapshot: SnapshotResponse;
  onOpenEvent: (eventId: string) => void;
}): React.ReactElement {
  const [date, setDate] = useState(snapshot.trip.dates[0] ?? snapshot.trip.start_date);
  const [tilesFailed, setTilesFailed] = useState(false);
  const day = snapshot.day_paths.find((entry) => entry.date === date);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex gap-1">
        {snapshot.trip.dates.map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setDate(value)}
            aria-pressed={value === date}
            className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
              value === date
                ? 'bg-stone-800 text-white'
                : 'bg-white text-stone-600 hover:bg-stone-100'
            }`}
          >
            {shortDay(value)} {value.slice(8)}
          </button>
        ))}
      </div>

      <Canvas snapshot={snapshot} day={day} onTileError={() => setTilesFailed(true)} />

      {tilesFailed && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-900">
          Map tiles could not load. The stops below are still correct.
        </p>
      )}

      <DayList snapshot={snapshot} day={day} onOpenEvent={onOpenEvent} />
    </div>
  );
}

function Canvas({
  snapshot,
  day,
  onTileError,
}: {
  snapshot: SnapshotResponse;
  day: DayPathResource | undefined;
  onTileError: () => void;
}): React.ReactElement {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const [sized, setSized] = useState(false);

  useEffect(() => {
    if (box.current === null || map.current !== null) return;
    const instance = L.map(box.current, { zoomControl: true }).setView(
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
    layer.current = L.layerGroup().addTo(instance);
    map.current = instance;

    // The panel can be mounted while hidden, where the container has no size
    // and Leaflet lays the map out against nothing.
    const observer = new ResizeObserver((entries) => {
      instance.invalidateSize();
      if ((entries[0]?.contentRect.height ?? 0) > 0) setSized(true);
    });
    observer.observe(box.current);

    return () => {
      observer.disconnect();
      // Tearing down mid-animation leaves Leaflet reading positions off
      // elements it has already dropped.
      instance.stop();
      instance.remove();
      map.current = null;
      layer.current = null;
    };
  }, [snapshot.trip.destination_center.lat, snapshot.trip.destination_center.lon, onTileError]);

  useEffect(() => {
    const group = layer.current;
    const instance = map.current;
    if (group === null || instance === null) return;
    group.clearLayers();

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
        { color: colors.get(edge.member_ids[0] ?? '') ?? '#78716c', weight: 3, opacity: 0.7 },
      ).addTo(group);
    }

    // One marker per event id: separate histories that reconverge on the same
    // stop share an event, and two markers on one point would read as two visits.
    for (const stop of distinctStops(day)) {
      if (stop.coordinate === null) continue;
      L.circleMarker([stop.coordinate.lat, stop.coordinate.lon], {
        radius: 8,
        color: '#ffffff',
        weight: 2,
        fillColor: colors.get(stop.member_ids[0] ?? '') ?? '#78716c',
        fillOpacity: 1,
      })
        .bindTooltip(
          snapshot.events.find((event) => event.id === stop.event_id)?.label ?? 'Removed',
          { direction: 'top' },
        )
        .addTo(group);
      points.push([stop.coordinate.lat, stop.coordinate.lon]);
    }

    if (points.length > 0 && sized) {
      instance.fitBounds(L.latLngBounds(points).pad(0.35), { maxZoom: 15, animate: false });
    }
  }, [snapshot, day, sized]);

  return (
    <div
      ref={box}
      role="application"
      aria-label="Map of the day"
      className="h-56 w-full shrink-0 overflow-hidden rounded-xl border border-stone-200 md:h-72"
    />
  );
}

type Stop = {
  event_id: string;
  member_ids: string[];
  coordinate: { lat: number; lon: number } | null;
  unresolved: boolean;
};

function distinctStops(day: DayPathResource | undefined): Stop[] {
  const stops = new Map<string, Stop>();
  for (const node of day?.nodes ?? []) {
    const existing = stops.get(node.event_id);
    if (existing === undefined) {
      stops.set(node.event_id, {
        event_id: node.event_id,
        member_ids: [...node.member_ids],
        coordinate: node.coordinate,
        unresolved: node.unresolved,
      });
      continue;
    }
    for (const id of node.member_ids) {
      if (!existing.member_ids.includes(id)) existing.member_ids.push(id);
    }
  }
  return [...stops.values()];
}

function DayList({
  snapshot,
  day,
  onOpenEvent,
}: {
  snapshot: SnapshotResponse;
  day: DayPathResource | undefined;
  onOpenEvent: (eventId: string) => void;
}): React.ReactElement {
  const people = new Map(snapshot.members.map((person) => [person.id, person]));
  const starts = new Map(snapshot.events.map((event) => [event.id, event.start_minute]));
  const stops = distinctStops(day).sort(
    (a, b) => (starts.get(a.event_id) ?? 0) - (starts.get(b.event_id) ?? 0),
  );

  if (stops.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-stone-300 px-3 py-2 text-xs text-stone-500">
        Nothing planned for this day.
      </p>
    );
  }

  return (
    <ol aria-label="Stops on this day" className="grid min-h-0 gap-1 overflow-y-auto">
      {stops.map((stop) => {
        const event = snapshot.events.find((row) => row.id === stop.event_id);
        return (
          <li key={stop.event_id}>
            <button
              type="button"
              onClick={() => onOpenEvent(stop.event_id)}
              className="flex w-full items-center justify-between gap-2 rounded-lg border border-stone-200 bg-white px-3 py-2 text-left hover:border-stone-300"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm text-stone-800">
                  {event?.label ?? 'Removed'}
                </span>
                <span className="text-[11px] text-stone-500">
                  {event === undefined ? '' : clock(event.start_minute)}
                  {stop.unresolved && ' · no location yet'}
                </span>
              </span>
              <span className="flex shrink-0 gap-1">
                {stop.member_ids.map((id) => (
                  <span
                    key={id}
                    aria-label={people.get(id)?.display_name}
                    className="inline-block size-2 rounded-full"
                    style={{ backgroundColor: people.get(id)?.color }}
                  />
                ))}
              </span>
            </button>
          </li>
        );
      })}
      {(day?.idle_member_ids.length ?? 0) > 0 && (
        <li className="px-1 pt-1 text-[11px] text-stone-500">
          Free:{' '}
          {(day?.idle_member_ids ?? [])
            .map((id) => people.get(id)?.display_name ?? 'someone')
            .join(', ')}
        </li>
      )}
    </ol>
  );
}
