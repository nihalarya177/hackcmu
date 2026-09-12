import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { MapPin } from 'lucide-react';
import type { DayPathResource, SnapshotResponse } from '@trip/contracts';
import { clock, money, shortDay } from './format';

type Stop = {
  event_id: string;
  order: number;
  label: string;
  startMinute: number;
  endMinute: number;
  price: number | null;
  members: string[];
  coordinate: { lat: number; lon: number } | null;
};

/**
 * Where the day actually goes.
 *
 * The plan is a sequence, so the map draws it as one: stops are numbered in
 * the order they happen, and selecting a stop in either the list or the map
 * highlights it in the other. Colour identifies who is going, taken from the
 * same member palette the calendar uses.
 */
export function PlanMap({
  snapshot,
  onOpenEvent,
}: {
  snapshot: SnapshotResponse;
  onOpenEvent: (eventId: string) => void;
}): React.ReactElement {
  const [date, setDate] = useState(snapshot.trip.dates[0] ?? snapshot.trip.start_date);
  const [selected, setSelected] = useState<string | null>(null);
  const [tilesFailed, setTilesFailed] = useState(false);
  const day = snapshot.day_paths.find((entry) => entry.date === date);

  const stops = useMemo(() => orderedStops(snapshot, day), [snapshot, day]);
  const located = stops.filter((stop) => stop.coordinate !== null);
  const unlocated = stops.filter((stop) => stop.coordinate === null);
  const people = new Map(snapshot.members.map((person) => [person.id, person]));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-1">
        {snapshot.trip.dates.map((value) => {
          const count = snapshot.day_paths.find((entry) => entry.date === value)?.nodes.length ?? 0;
          return (
            <button
              key={value}
              type="button"
              onClick={() => {
                setDate(value);
                setSelected(null);
              }}
              aria-pressed={value === date}
              className={`flex items-baseline gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                value === date ? 'bg-stone-800 text-white' : 'text-stone-600 hover:bg-stone-100'
              }`}
            >
              {shortDay(value)} {value.slice(8)}
              {count > 0 && (
                <span className={value === date ? 'text-stone-300' : 'text-stone-400'}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <Canvas
        snapshot={snapshot}
        day={day}
        stops={located}
        selected={selected}
        onSelect={setSelected}
        onTileError={() => setTilesFailed(true)}
      />

      {tilesFailed && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-900">
          Map tiles could not load. The stops below are still correct.
        </p>
      )}

      {stops.length === 0 ? (
        <p className="rounded-xl border border-dashed border-stone-300 px-3 py-2 text-xs text-stone-500">
          Nothing planned for this day.
        </p>
      ) : (
        <ol aria-label="Stops on this day" className="grid min-h-0 gap-1 overflow-y-auto pr-0.5">
          {stops.map((stop) => (
            <li key={stop.event_id}>
              <button
                type="button"
                onMouseEnter={() => stop.coordinate !== null && setSelected(stop.event_id)}
                onClick={() => onOpenEvent(stop.event_id)}
                className={`flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition ${
                  selected === stop.event_id
                    ? 'border-stone-800 bg-stone-50'
                    : 'border-stone-200 bg-white hover:border-stone-300'
                }`}
              >
                <span
                  aria-hidden
                  className="grid size-5 shrink-0 place-items-center rounded-full text-[10px] font-bold text-white"
                  style={{ backgroundColor: people.get(stop.members[0] ?? '')?.color ?? '#78716c' }}
                >
                  {stop.order}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-stone-800">{stop.label}</span>
                  <span className="text-[11px] text-stone-500">
                    {clock(stop.startMinute)} – {clock(stop.endMinute)}
                    {stop.price !== null && ` · ${money(stop.price)}`}
                    {stop.coordinate === null && ' · no location yet'}
                  </span>
                </span>
                <span className="flex shrink-0 -space-x-1">
                  {stop.members.map((id) => (
                    <span
                      key={id}
                      aria-label={people.get(id)?.display_name}
                      className="inline-block size-2.5 rounded-full ring-2 ring-white"
                      style={{ backgroundColor: people.get(id)?.color }}
                    />
                  ))}
                </span>
              </button>
            </li>
          ))}
          {(day?.idle_member_ids.length ?? 0) > 0 && (
            <li className="px-1 pt-0.5 text-[11px] text-stone-500">
              Free all day:{' '}
              {(day?.idle_member_ids ?? [])
                .map((id) => people.get(id)?.display_name ?? 'someone')
                .join(', ')}
            </li>
          )}
        </ol>
      )}

      {unlocated.length > 0 && located.length > 0 && (
        <p className="flex items-center gap-1.5 text-[11px] text-stone-500">
          <MapPin aria-hidden className="size-3" />
          {unlocated.length} stop{unlocated.length === 1 ? '' : 's'} not on the map yet
        </p>
      )}
    </div>
  );
}

function Canvas({
  snapshot,
  day,
  stops,
  selected,
  onSelect,
  onTileError,
}: {
  snapshot: SnapshotResponse;
  day: DayPathResource | undefined;
  stops: Stop[];
  selected: string | null;
  onSelect: (eventId: string) => void;
  onTileError: () => void;
}): React.ReactElement {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const [sized, setSized] = useState(false);

  useEffect(() => {
    if (box.current === null || map.current !== null) return;
    const instance = L.map(box.current, { zoomControl: true, attributionControl: true }).setView(
      [snapshot.trip.destination_center.lat, snapshot.trip.destination_center.lon],
      13,
    );
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap contributors',
    })
      .on('tileerror', onTileError)
      .addTo(instance);
    layer.current = L.layerGroup().addTo(instance);
    map.current = instance;

    const observer = new ResizeObserver((entries) => {
      instance.invalidateSize();
      if ((entries[0]?.contentRect.height ?? 0) > 0) setSized(true);
    });
    observer.observe(box.current);

    return () => {
      observer.disconnect();
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

    // One line per person, dashed differently, so two people walking the same
    // leg are both visible instead of one hiding under the other.
    for (const edge of day?.edges ?? []) {
      if (!edge.drawable) continue;
      const from = nodes.get(edge.from_node_id)?.coordinate;
      const to = nodes.get(edge.to_node_id)?.coordinate;
      if (from == null || to == null) continue;
      for (const [index, memberId] of edge.member_ids.entries()) {
        L.polyline(
          [
            [from.lat, from.lon],
            [to.lat, to.lon],
          ],
          {
            color: colors.get(memberId) ?? '#78716c',
            weight: 2.5,
            opacity: 0.8,
            dashArray: index === 0 ? undefined : `${4 + index * 3} ${4 + index * 3}`,
          },
        ).addTo(group);
      }
    }

    for (const stop of stops) {
      if (stop.coordinate === null) continue;
      const tint = colors.get(stop.members[0] ?? '') ?? '#78716c';
      const isSelected = stop.event_id === selected;

      // A numbered pin: the plan is a sequence, so the map shows the order.
      const marker = L.marker([stop.coordinate.lat, stop.coordinate.lon], {
        icon: L.divIcon({
          className: '',
          html: `<span style="
            display:grid;place-items:center;
            width:${isSelected ? 30 : 24}px;height:${isSelected ? 30 : 24}px;
            border-radius:9999px;background:${tint};color:#fff;
            font:600 ${isSelected ? 13 : 11}px system-ui,sans-serif;
            box-shadow:0 0 0 ${isSelected ? 3 : 2}px #fff,0 1px 4px rgba(0,0,0,.4);
          ">${stop.order}</span>`,
          iconSize: [isSelected ? 30 : 24, isSelected ? 30 : 24],
          iconAnchor: [isSelected ? 15 : 12, isSelected ? 15 : 12],
        }),
        zIndexOffset: isSelected ? 1000 : 0,
      })
        .bindTooltip(
          `<b>${escapeHtml(stop.label)}</b><br>${clock(stop.startMinute)} – ${clock(stop.endMinute)}`,
          { direction: 'top', offset: [0, -14] },
        )
        .on('click', () => onSelect(stop.event_id));
      marker.addTo(group);
    }

    const points = stops
      .filter((stop) => stop.coordinate !== null)
      .map((stop) => [stop.coordinate!.lat, stop.coordinate!.lon] as L.LatLngExpression);
    if (points.length > 0 && sized) {
      instance.fitBounds(L.latLngBounds(points).pad(0.3), { maxZoom: 15, animate: false });
    }
  }, [snapshot, day, stops, selected, sized, onSelect]);

  return (
    <div
      ref={box}
      role="application"
      aria-label="Map of the day"
      className="min-h-48 w-full flex-1 overflow-hidden rounded-xl border border-stone-200"
    />
  );
}

/**
 * The day's distinct stops in the order they happen.
 *
 * The prefix tree keeps one node per history, so a stop two groups both attend
 * appears more than once; they merge back into one entry carrying everyone.
 */
function orderedStops(snapshot: SnapshotResponse, day: DayPathResource | undefined): Stop[] {
  const merged = new Map<string, { members: string[]; coordinate: Stop['coordinate'] }>();
  for (const node of day?.nodes ?? []) {
    const existing = merged.get(node.event_id);
    if (existing === undefined) {
      merged.set(node.event_id, { members: [...node.member_ids], coordinate: node.coordinate });
      continue;
    }
    for (const id of node.member_ids) {
      if (!existing.members.includes(id)) existing.members.push(id);
    }
  }

  return [...merged.entries()]
    .map(([eventId, value]) => {
      const event = snapshot.events.find((row) => row.id === eventId);
      return {
        event_id: eventId,
        order: 0,
        label: event?.label ?? 'Removed',
        startMinute: event?.start_minute ?? 0,
        endMinute: event?.end_minute ?? 0,
        price: event?.price_cents ?? null,
        members: value.members,
        coordinate: value.coordinate,
      };
    })
    .sort((a, b) => a.startMinute - b.startMinute)
    .map((stop, index) => ({ ...stop, order: index + 1 }));
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );
}
