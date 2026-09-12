import { TRIP_LIMITS } from '@trip/contracts';
import { AppError } from './errors.js';

/**
 * Trip dates are calendar dates in the trip timezone, inclusive of both ends.
 * End minus start is zero through six days, so a trip spans one to seven dates.
 */
export function enumerateTripDates(startDate: string, endDate: string): string[] {
  const start = parseIsoDate(startDate);
  const end = parseIsoDate(endDate);
  const spanDays = Math.round((end - start) / 86_400_000);

  if (spanDays < 0) {
    throw new AppError('UNPROCESSABLE', 'end_date must not be before start_date', {
      fieldErrors: [{ path: 'end_date', message: 'must not be before start_date' }],
    });
  }
  if (spanDays + 1 > TRIP_LIMITS.maxTripDays) {
    throw new AppError('UNPROCESSABLE', `a trip covers at most ${TRIP_LIMITS.maxTripDays} dates`, {
      fieldErrors: [
        { path: 'end_date', message: `at most ${TRIP_LIMITS.maxTripDays} inclusive dates` },
      ],
    });
  }

  const dates: string[] = [];
  for (let offset = 0; offset <= spanDays; offset += 1) {
    dates.push(formatIsoDate(start + offset * 86_400_000));
  }
  return dates;
}

function parseIsoDate(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    throw new AppError('BAD_REQUEST', 'dates must be formatted YYYY-MM-DD');
  }
  const [, year, month, day] = match;
  const timestamp = Date.UTC(Number(year), Number(month) - 1, Number(day));
  if (Number.isNaN(timestamp) || formatIsoDate(timestamp) !== value) {
    throw new AppError('BAD_REQUEST', `${value} is not a real calendar date`);
  }
  return timestamp;
}

function formatIsoDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}
