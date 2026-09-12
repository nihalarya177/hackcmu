import { describe, expect, it } from 'vitest';
import { enumerateTripDates } from '../../apps/server/src/domain/tripDates.js';
import { AppError } from '../../apps/server/src/domain/errors.js';

describe('trip dates', () => {
  it('includes both ends of the range', () => {
    expect(enumerateTripDates('2026-10-02', '2026-10-04')).toEqual([
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
    ]);
  });

  it('accepts a single-day trip', () => {
    expect(enumerateTripDates('2026-10-02', '2026-10-02')).toEqual(['2026-10-02']);
  });

  it('accepts exactly seven inclusive dates', () => {
    expect(enumerateTripDates('2026-10-02', '2026-10-08')).toHaveLength(7);
  });

  it('rejects an eighth date', () => {
    expect(() => enumerateTripDates('2026-10-02', '2026-10-09')).toThrow(AppError);
  });

  it('rejects an end before the start', () => {
    expect(() => enumerateTripDates('2026-10-04', '2026-10-02')).toThrow(AppError);
  });

  it('rejects a date that does not exist', () => {
    expect(() => enumerateTripDates('2026-02-30', '2026-03-01')).toThrow(AppError);
  });

  it('rejects a malformed date', () => {
    expect(() => enumerateTripDates('2026-2-1', '2026-02-03')).toThrow(AppError);
  });

  it('counts calendar days across a DST transition', () => {
    // US clocks move on 2026-11-01; the trip still covers three calendar dates.
    expect(enumerateTripDates('2026-10-31', '2026-11-02')).toEqual([
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ]);
  });

  it('crosses a month and a year boundary', () => {
    expect(enumerateTripDates('2026-12-30', '2027-01-02')).toEqual([
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
    ]);
  });
});
