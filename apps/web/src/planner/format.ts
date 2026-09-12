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
  const suffix = hour < 12 || hour === 24 ? 'am' : 'pm';
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return minutes === 0
    ? `${display}${suffix}`
    : `${display}:${String(minutes).padStart(2, '0')}${suffix}`;
}

export function dayLabel(date: string): string {
  return DateTime.fromISO(date).toFormat('ccc d LLL');
}

export function shortDay(date: string): string {
  return DateTime.fromISO(date).toFormat('ccc');
}

export function timeAgo(iso: string): string {
  const then = DateTime.fromISO(iso);
  const minutes = Math.round(Math.abs(DateTime.now().diff(then, 'minutes').minutes));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  return then.toFormat('h:mm a');
}

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

/** Initials for a member chip, from whatever they called themselves. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() ?? '').join('') || '?';
}

export function commandKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
