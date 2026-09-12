import { DateTime } from 'luxon';

/** Money is integer cents everywhere; only display turns it into dollars. */
export function money(cents: number): string {
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  });
}

/** Minute offset from local midnight, as a clock time. */
export function clock(minute: number): string {
  const hour = Math.floor(minute / 60);
  const minutes = minute % 60;
  const suffix = hour < 12 || hour === 24 ? 'AM' : 'PM';
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return minutes === 0
    ? `${display} ${suffix}`
    : `${display}:${String(minutes).padStart(2, '0')} ${suffix}`;
}

export function dayLabel(date: string): string {
  return DateTime.fromISO(date).toFormat('ccc d LLL');
}

export function timeOfDay(iso: string, zone: string): string {
  return DateTime.fromISO(iso, { zone }).toFormat('h:mm a');
}

/** `600` from `"10:00"`, for the event form. */
export function minuteFromInput(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 24 || minutes > 59 || hours * 60 + minutes > 1440) return null;
  return hours * 60 + minutes;
}

export function inputFromMinute(minute: number): string {
  return `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

/** A short, stable idempotency key. The demo and the live API both need one. */
export function commandKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
