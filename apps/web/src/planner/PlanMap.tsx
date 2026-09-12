import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Minus, Plus } from 'lucide-react';
import type { DayPathResource, SnapshotResponse } from '@trip/contracts';
import { loadBrowserConfig } from '../config/env';
import { clock, money, shortDay } from './format';

/**
 * The basemap.
 *
 * CARTO Positron when a key is configured: near-white land, thin grey roads,
 * restrained labels, so the member colours are the only saturated things on
 * screen. Without a key CARTO stamps "API KEY REQUIRED" across every tile, so
 * the fallback is plain OpenStreetMap, drained in CSS to get close.
 */
function basemap(): { url: string; attribution: string; clean: boolean } {
  const key = loadBrowserConfig().cartoApiKey;
  if (key === null) {
    return {
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      attribution: '© OpenStreetMap contributors',
      clean: false,
    };
  }
  return {
    url: `https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png?key=${encodeURIComponent(key)}`,
    attribution: '© OpenStreetMap contributors © CARTO',
    clean: true,
  };
}

type Stop = {
  eventId: string;
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
 * One full-bleed canvas rather than a map in a box with a list under it. The
 * basemap is deliberately near-monochrome so the member colours are the only
 * saturated thing on screen; the stops ride over it as cards, the way a person
 * reads a day — in order.
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
  const people = useMemo(
    () => new Map(snapshot.members.map((person) => [person.id, person])),
    [snapshot.members],
  );
  const cards = useRef(new Map<string, HTMLLIElement>());

  // Selecting a pin brings its card to the middle of the strip.
  useEffect(() => {
    if (selected === null) return;
    cards.current
      .get(selected)
      ?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }, [selected]);

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl ring-1 ring-stone-200/70">
      <Canvas
        snapshot={snapshot}
        day={day}
        stops={stops}
        selected={selected}
        onSelect={setSelected}
        onTileError={() => setTilesFailed(true)}
      />

      {/* Day selector, floating over the canvas. */}
      <div className="pointer-events-auto absolute top-3 left-3 z-[500] flex gap-0.5 rounded-full bg-white/85 p-0.5 shadow-[0_2px_12px_rgb(0_0_0/0.10)] backdrop-blur">
        {snapshot.trip.dates.map((value) => {
          const count = snapshot.day_paths.find((entry) => entry.date === value)?.nodes.length ?? 0;
          const active = value === date;
          return (
            <button
              key={value}
              type="button"
              onClick={() => {
                setDate(value);
                setSelected(null);
              }}
              aria-pressed={active}
              className={`flex items-baseline gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition ${
                active ? 'bg-stone-900 text-white' : 'text-stone-600 hover:bg-stone-900/5'
              }`}
            >
              {shortDay(value)} {value.slice(8)}
              {count > 0 && (
                <span className={active ? 'text-white/55' : 'text-stone-400'}>{count}</span>
              )}
            </button>
          );
        })}
      </div>

      {tilesFailed && (
        <p className="absolute top-3 right-3 z-[500] rounded-full bg-amber-50/95 px-3 py-1.5 text-[11px] text-amber-900 shadow backdrop-blur">
          Map tiles unavailable — the stops below are still correct.
        </p>
      )}

      {/* Stop cards, the way a place card strip works on a phone map. */}
      {stops.length === 0 ? (
        <p className="absolute inset-x-3 bottom-7 z-[500] rounded-xl bg-white/90 px-3 py-2 text-center text-xs text-stone-500 shadow backdrop-blur">
          Nothing planned for this day.
        </p>
      ) : (
        <ol
          aria-label="Stops on this day"
          className="absolute inset-x-0 bottom-7 z-[500] flex snap-x snap-mandatory gap-2 overflow-x-auto px-3 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {stops.map((stop) => {
            const tint = people.get(stop.members[0] ?? '')?.color ?? '#78716c';
            const active = stop.eventId === selected;
            return (
              <li
                key={stop.eventId}
                ref={(node) => {
                  if (node === null) cards.current.delete(stop.eventId);
                  else cards.current.set(stop.eventId, node);
                }}
                className="w-56 shrink-0 snap-center"
              >
                <button
                  type="button"
                  onMouseEnter={() => setSelected(stop.eventId)}
                  onFocus={() => setSelected(stop.eventId)}
                  onClick={() => onOpenEvent(stop.eventId)}
                  className={`w-full rounded-xl bg-white/95 p-2.5 text-left shadow-[0_2px_14px_rgb(0_0_0/0.12)] ring-1 backdrop-blur transition ${
                    active ? 'ring-stone-900/70' : 'ring-black/5 hover:ring-stone-300'
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className="grid size-5 shrink-0 place-items-center rounded-full text-[10px] font-bold text-white"
                      style={{ backgroundColor: tint }}
                    >
                      {stop.order}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-stone-900">
                      {stop.label}
                    </span>
                    <span className="flex shrink-0 -space-x-1">
                      {stop.members.map((id) => (
                        <span
                          key={id}
                          aria-label={people.get(id)?.display_name}
                          className="inline-block size-2 rounded-full ring-2 ring-white"
                          style={{ backgroundColor: people.get(id)?.color }}
                        />
                      ))}
                    </span>
                  </span>
                  <span className="mt-1 flex items-baseline justify-between gap-2 text-[11px] text-stone-500">
                    <span className="truncate">
                      {clock(stop.startMinute)} – {clock(stop.endMinute)}
                      {stop.coordinate === null && ' · no location yet'}
                    </span>
                    <span className="shrink-0 tabular-nums">
                      {stop.price === null ? '' : money(stop.price)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
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
    const instance = L.map(box.current, {
      // The default control is the most recognisably dated thing on the map.
      zoomControl: false,
      attributionControl: true,
    }).setView([snapshot.trip.destination_center.lat, snapshot.trip.destination_center.lon], 13);

    const tiles = basemap();
    box.current.dataset['basemap'] = tiles.clean ? 'clean' : 'osm';
    L.tileLayer(tiles.url, {
      maxZoom: tiles.clean ? 20 : 19,
      subdomains: tiles.clean ? 'abcd' : 'abc',
      detectRetina: tiles.clean,
      attribution: tiles.attribution,
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

    for (const edge of day?.edges ?? []) {
      if (!edge.drawable) continue;
      const from = nodes.get(edge.from_node_id)?.coordinate;
      const to = nodes.get(edge.to_node_id)?.coordinate;
      if (from == null || to == null) continue;
      const line: L.LatLngExpression[] = [
        [from.lat, from.lon],
        [to.lat, to.lon],
      ];

      // A dark casing under a coloured core, so a route stays legible over
      // pale streets and dark parks alike.
      L.polyline(line, {
        color: '#1c1917',
        weight: 6,
        opacity: 0.12,
        lineCap: 'round',
        lineJoin: 'round',
      }).addTo(group);

      for (const [index, memberId] of edge.member_ids.entries()) {
        L.polyline(line, {
          color: colors.get(memberId) ?? '#78716c',
          weight: 2.5,
          opacity: 0.9,
          lineCap: 'round',
          // Two people on the same leg must both be visible.
          dashArray: index === 0 ? undefined : `${3 + index * 4} ${5 + index * 3}`,
        }).addTo(group);
      }
    }

    for (const stop of stops) {
      if (stop.coordinate === null) continue;
      const tint = colors.get(stop.members[0] ?? '') ?? '#78716c';
      const active = stop.eventId === selected;
      const size = active ? 34 : 28;

      L.marker([stop.coordinate.lat, stop.coordinate.lon], {
        icon: L.divIcon({
          className: '',
          html: `<span style="
            display:grid;place-items:center;
            width:${size}px;height:${size}px;border-radius:9999px;
            background:#fff;color:${tint};
            border:${active ? 3 : 2.5}px solid ${tint};
            font:700 ${active ? 14 : 12}px ui-sans-serif,system-ui,sans-serif;
            box-shadow:0 ${active ? 6 : 3}px ${active ? 16 : 8}px rgb(0 0 0 / ${active ? 0.3 : 0.2});
            transition:all .15s ease;
          ">${stop.order}</span>`,
          iconSize: [size, size],
          iconAnchor: [size / 2, size / 2],
        }),
        zIndexOffset: active ? 1000 : 0,
        riseOnHover: true,
      })
        .bindTooltip(`${escapeHtml(stop.label)} · ${clock(stop.startMinute)}`, {
          direction: 'top',
          offset: [0, -size / 2 - 4],
        })
        .on('click', () => onSelect(stop.eventId))
        .addTo(group);
    }

    const points = stops
      .filter((stop) => stop.coordinate !== null)
      .map((stop) => [stop.coordinate!.lat, stop.coordinate!.lon] as L.LatLngExpression);
    if (points.length > 0 && sized) {
      instance.fitBounds(L.latLngBounds(points), {
        // Room for the floating day pills above and the card strip below.
        paddingTopLeft: [24, 56],
        paddingBottomRight: [24, 110],
        maxZoom: 15,
        animate: false,
      });
    }
  }, [snapshot, day, stops, selected, sized, onSelect]);

  // Panning to a selection is a movement, not a jump.
  useEffect(() => {
    const instance = map.current;
    const stop = stops.find((row) => row.eventId === selected);
    if (instance === null || stop?.coordinate == null || !sized) return;
    instance.panTo([stop.coordinate.lat, stop.coordinate.lon], {
      animate: true,
      duration: 0.4,
    });
  }, [selected, stops, sized]);

  return (
    <>
      <div ref={box} role="application" aria-label="Map of the day" className="absolute inset-0" />
      <div className="absolute right-3 bottom-28 z-[500] flex flex-col overflow-hidden rounded-full bg-white/85 shadow-[0_2px_12px_rgb(0_0_0/0.10)] backdrop-blur">
        <button
          type="button"
          aria-label="Zoom in"
          onClick={() => map.current?.zoomIn()}
          className="grid size-8 place-items-center text-stone-700 hover:bg-stone-900/5"
        >
          <Plus aria-hidden className="size-4" />
        </button>
        <button
          type="button"
          aria-label="Zoom out"
          onClick={() => map.current?.zoomOut()}
          className="grid size-8 place-items-center text-stone-700 hover:bg-stone-900/5"
        >
          <Minus aria-hidden className="size-4" />
        </button>
      </div>
    </>
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
        eventId,
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
