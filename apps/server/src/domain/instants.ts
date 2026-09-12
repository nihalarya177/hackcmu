import { DateTime } from 'luxon';
import { AppError } from './errors.js';

/**
 * Local trip time to absolute instants.
 *
 * Events are stored as a calendar date plus minute offsets in the trip's zone,
 * because that is what people agree on. The canonical `starts_at`/`ends_at`
 * instants are derived here and never accepted from a client.
 *
 * Minute 1440 is end of day, which is midnight on the following date.
 */
export function instantFor(localDate: string, minute: number, timezone: string): Date {
  const midnight = DateTime.fromISO(localDate, { zone: timezone });
  if (!midnight.isValid) {
    throw new AppError('UNPROCESSABLE', `${localDate} is not a valid date in ${timezone}`, {
      fieldErrors: [{ path: 'local_date', message: 'not a valid date in the trip timezone' }],
    });
  }

  const moment = midnight.plus({ minutes: minute });

  // Luxon silently rolls a nonexistent local time forward across a spring
  // transition. Storing that would mean the plan says one time and the instant
  // means another, so it is rejected instead.
  const expectedMinutes = minute % 1440;
  const observedMinutes = moment.hour * 60 + moment.minute;
  if (observedMinutes !== expectedMinutes) {
    throw new AppError(
      'UNPROCESSABLE',
      `${clockOf(minute)} does not exist on ${localDate} in ${timezone}: the clocks change that day`,
      { fieldErrors: [{ path: 'start_minute', message: 'that local time does not exist' }] },
    );
  }

  return moment.toJSDate();
}

/**
 * Both instants for one event, with the interval checked in local terms first.
 * An ambiguous autumn time is accepted: both readings are real, and Luxon
 * resolves to the earlier offset consistently.
 */
export function eventInstants(
  localDate: string,
  startMinute: number,
  endMinute: number,
  timezone: string,
): { startsAt: Date; endsAt: Date } {
  if (endMinute <= startMinute) {
    throw new AppError('UNPROCESSABLE', 'An event must end after it starts', {
      fieldErrors: [{ path: 'end_minute', message: 'must be after start_minute' }],
    });
  }
  const startsAt = instantFor(localDate, startMinute, timezone);
  const endsAt = instantFor(localDate, endMinute, timezone);
  if (endsAt <= startsAt) {
    throw new AppError('UNPROCESSABLE', 'The clocks change makes that interval empty', {
      fieldErrors: [{ path: 'end_minute', message: 'must be after start_minute' }],
    });
  }
  return { startsAt, endsAt };
}

/** The trip's dates are the only dates an event may fall on. */
export function assertTripDate(dates: string[], localDate: string): void {
  if (!dates.includes(localDate)) {
    throw new AppError('UNPROCESSABLE', 'That date is not part of this trip', {
      fieldErrors: [{ path: 'local_date', message: 'not one of the trip dates' }],
    });
  }
}

function clockOf(minute: number): string {
  const hours = String(Math.floor(minute / 60) % 24).padStart(2, '0');
  return `${hours}:${String(minute % 60).padStart(2, '0')}`;
}
