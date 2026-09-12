import OpeningHours from 'opening_hours';
import { DateTime } from 'luxon';
import type { PlaceResource } from '@trip/contracts';

type HoursDay = PlaceResource['hours_days'][number];

/**
 * Normalizes provider opening hours into this trip's exact dates.
 *
 * The grammar is evaluated per actual date in the trip's own timezone, so a
 * rule like "Th 10:00-20:00" lands on the right day. A date the venue is
 * closed gets an entry with zero intervals — which is not the same as no entry
 * at all, and the difference is the whole point: no entry means unknown.
 */
export function normalizeHours(options: {
  raw: string;
  dates: string[];
  timezone: string;
}): HoursDay[] | null {
  let parser: OpeningHours;
  try {
    // No location is supplied on purpose. The parser only uses it to resolve
    // holiday and sunrise-relative rules, and it needs a country AND a state,
    // which cannot be derived from coordinates alone. Guessing one would
    // invent closures on public holidays; an expression that genuinely needs
    // it simply fails below and the schedule stays unknown.
    parser = new OpeningHours(options.raw);
  } catch {
    // An expression this parser cannot read leaves the schedule unknown
    // rather than guessed.
    return null;
  }

  const days: HoursDay[] = [];
  for (const date of options.dates) {
    const start = DateTime.fromISO(date, { zone: options.timezone });
    if (!start.isValid) continue;
    const end = start.plus({ days: 1 });

    let intervals: [Date, Date, boolean, string | undefined][];
    try {
      intervals = parser.getOpenIntervals(start.toJSDate(), end.toJSDate());
    } catch {
      return null;
    }

    days.push({
      date,
      intervals: intervals
        .map(([from, to]) => ({
          start_minute: minuteOf(from, options.timezone, date),
          end_minute: minuteOf(to, options.timezone, date),
        }))
        .filter((interval) => interval.end_minute > interval.start_minute),
    });
  }
  return days;
}

/** Minutes from that date's local midnight, clamped to the day it belongs to. */
function minuteOf(instant: Date, timezone: string, date: string): number {
  const local = DateTime.fromJSDate(instant, { zone: timezone });
  const midnight = DateTime.fromISO(date, { zone: timezone });
  const minutes = Math.round(local.diff(midnight, 'minutes').minutes);
  return Math.max(0, Math.min(1440, minutes));
}
