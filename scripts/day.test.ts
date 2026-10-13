import {describe, expect, it} from 'vitest';
import {dayNumber, dayStart} from '../src/day';

describe('day rollover', () => {
  it('rolls at local midnight in TZ, not UTC', () => {
    // Oakle #1 is 2026-10-13 in Auckland (NZDT, UTC+13): it starts at 2026-10-12T11:00Z
    expect(dayNumber(new Date('2026-10-12T10:59:00Z'))).toBe(0); // 23:59 on the 12th, the day before launch
    expect(dayNumber(new Date('2026-10-12T11:00:00Z'))).toBe(1); // midnight
    expect(dayNumber(new Date('2026-10-12T21:18:00Z'))).toBe(1); // 10:18 on the 13th: still day 1, not a UTC-midnight rollover
    expect(dayNumber(new Date('2026-10-13T10:59:00Z'))).toBe(1); // 23:59 on the 13th
    expect(dayNumber(new Date('2026-10-13T11:00:00Z'))).toBe(2); // midnight
  });
  it('dayStart is the first instant of the day', () => {
    for (const d of [1, 2, 30, 200]) {
      const s = dayStart(d);
      expect(dayNumber(new Date(s))).toBe(d);
      expect(dayNumber(new Date(s - 1))).toBe(d - 1);
    }
  });
});
