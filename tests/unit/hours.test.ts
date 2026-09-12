import { describe, expect, it } from 'vitest';
import { normalizeHours } from '../../apps/server/src/places/hours.js';

const dates = ['2026-10-01', '2026-10-02', '2026-10-03'];
const timezone = 'America/New_York';

describe('opening hours normalization', () => {
  it('turns the provider grammar into minutes on each exact trip date', () => {
    // Thursday 1 October gets the later closing; the other days do not.
    const days = normalizeHours({ raw: '10:00-17:00; Th 10:00-20:00', dates, timezone });
    expect(days).not.toBeNull();
    expect(days?.map((day) => day.date)).toEqual(dates);
    expect(days?.[0]?.intervals).toEqual([{ start_minute: 600, end_minute: 1200 }]);
    expect(days?.[1]?.intervals).toEqual([{ start_minute: 600, end_minute: 1020 }]);
  });

  it('records a closed day as zero intervals, which is not the same as unknown', () => {
    // Later rules override earlier ones in this grammar, so the exception
    // comes second.
    const days = normalizeHours({ raw: '10:00-17:00; Fr off', dates, timezone });
    const friday = days?.find((day) => day.date === '2026-10-02');
    // An entry with no intervals means known closed; no entry at all means
    // unknown, and the two must never be conflated.
    expect(friday).toBeDefined();
    expect(friday?.intervals).toEqual([]);
  });

  it('handles a split day', () => {
    const days = normalizeHours({ raw: '09:00-12:00,13:00-17:00', dates, timezone });
    expect(days?.[0]?.intervals).toEqual([
      { start_minute: 540, end_minute: 720 },
      { start_minute: 780, end_minute: 1020 },
    ]);
  });

  it('leaves the schedule unknown when the expression cannot be read', () => {
    expect(normalizeHours({ raw: 'not an opening hours expression', dates, timezone })).toBeNull();
  });
});
