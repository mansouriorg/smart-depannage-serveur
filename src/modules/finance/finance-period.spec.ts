import { DEFAULT_PERIOD_DAYS, MAX_PERIOD_DAYS, periodOf, shiftDay } from './finance-period';

/** The business clock is Africa/Tunis (UTC+1, no summer time): 2026-10-19 begins at 2026-10-18T23:00:00Z. */
const NOW = new Date('2026-10-24T20:00:00.000Z');

function refusal(work: () => unknown): string | null {
  try {
    work();
  } catch (error) {
    return String((error as Error).message);
  }

  return null;
}

describe('the period of a finance screen (P2-08)', () => {
  it('is the last seven days, today included, when nothing is named', () => {
    const period = periodOf(undefined, undefined, NOW);

    expect(DEFAULT_PERIOD_DAYS).toBe(7);
    expect(period.from).toBe('2026-10-18');
    expect(period.to).toBe('2026-10-24');
    expect(period.days).toEqual(['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24']);
    expect(period.explicit).toBe(false);
  });

  it('reads "today" on the clock of the business, not of the server', () => {
    // 23:30 UTC on the 24th is 00:30 on the 25th in Tunis.
    expect(periodOf(undefined, undefined, new Date('2026-10-24T23:30:00.000Z')).to).toBe('2026-10-25');
    expect(periodOf(undefined, undefined, new Date('2026-10-24T22:59:59.999Z')).to).toBe('2026-10-24');
  });

  it('is the seven days that end on the day named when only the end is named, and the seven that begin on it when only the start is', () => {
    const ending = periodOf(undefined, '2026-10-25', NOW);
    const beginning = periodOf('2026-10-19', undefined, NOW);

    expect([ending.from, ending.to, ending.explicit]).toEqual(['2026-10-19', '2026-10-25', true]);
    expect([beginning.from, beginning.to, beginning.explicit]).toEqual(['2026-10-19', '2026-10-25', true]);
  });

  it('runs from the first instant of the first day to the last instant of the last day, as the clock of the business has them', () => {
    const period = periodOf('2026-10-19', '2026-10-25', NOW);

    expect(period.start.toISOString()).toBe('2026-10-18T23:00:00.000Z');
    expect(period.end.toISOString()).toBe('2026-10-25T23:00:00.000Z');
    expect(period.days).toHaveLength(7);
    expect(period.explicit).toBe(true);
  });

  it('may be a single day', () => {
    const period = periodOf('2026-10-20', '2026-10-20', NOW);

    expect(period.days).toEqual(['2026-10-20']);
    expect(period.end.getTime() - period.start.getTime()).toBe(24 * 3600 * 1000);
  });

  it('has days of the same length at the end of March too (the clock of Tunis does not change)', () => {
    const period = periodOf('2026-03-28', '2026-03-30', NOW);

    expect(period.end.getTime() - period.start.getTime()).toBe(3 * 24 * 3600 * 1000);
  });

  it('refuses a period that goes backwards', () => {
    expect(refusal(() => periodOf('2026-10-25', '2026-10-19', NOW))).toMatch(/premier jour est après le dernier/);
  });

  it('allows 93 days and refuses 94', () => {
    expect(MAX_PERIOD_DAYS).toBe(93);
    expect(periodOf('2026-07-01', '2026-10-01', NOW).days).toHaveLength(93);
    expect(refusal(() => periodOf('2026-06-30', '2026-10-01', NOW))).toMatch(/ne peut pas dépasser 93 jours/);
  });

  it('refuses a day that is not in the calendar instead of moving it to the next month', () => {
    expect(refusal(() => periodOf('2026-11-31', undefined, NOW))).toMatch(/« du »/);
    expect(refusal(() => periodOf(undefined, '2026-02-30', NOW))).toMatch(/« au »/);
    expect(refusal(() => periodOf('2026-13-01', undefined, NOW))).toMatch(/pas un jour du calendrier/);
    expect(refusal(() => periodOf('hier', undefined, NOW))).toMatch(/pas un jour du calendrier/);
  });

  it('takes an empty day as no day', () => {
    const period = periodOf('', null, NOW);

    expect(period.explicit).toBe(false);
    expect(period.to).toBe('2026-10-24');
  });

  it('moves a day over the end of a month, of a year and across 29 February', () => {
    expect(shiftDay('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDay('2028-02-28', 1)).toBe('2028-02-29');
    expect(shiftDay('2026-02-28', 1)).toBe('2026-03-01');
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDay('2026-10-19', 0)).toBe('2026-10-19');
    expect(shiftDay('2026-10-19', 6)).toBe('2026-10-25');
  });

  it('counts the days of a period that crosses a year', () => {
    const period = periodOf('2026-12-29', '2027-01-02', NOW);

    expect(period.days).toEqual(['2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
  });
});
