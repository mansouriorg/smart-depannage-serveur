import { zonedInstant } from '../availability/weekly-schedule';
import {
  businessClock,
  businessDateOf,
  businessDayWindow,
  businessMonthRange,
  businessYearMonth,
  instantOf,
  nextDate,
  startOfBusinessDay,
  startOfBusinessMonth,
} from './business-time';
import { applyLocale, resetLocale } from './locale';

/** Runs `run` with the clock of the process set to `zone`, then puts it back. */
function inProcessZone(zone: string, run: () => void) {
  const before = process.env.TZ;

  try {
    process.env.TZ = zone;
    run();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

const ZONES = ['UTC', 'Africa/Tunis', 'Europe/Paris', 'America/Los_Angeles', 'Pacific/Auckland', 'Asia/Kolkata'];

describe('days and months are the ones of the business clock, whatever the clock of the server is (P2-01)', () => {
  beforeEach(() => resetLocale());

  it('today starts at midnight in Tunis, not at midnight where the server runs', () => {
    // 23 Oct 2026 22:30 UTC is 23:30 in Tunis (UTC+1, no summer time): still the 23rd, though it is already the 24th in Auckland.
    const evening = new Date('2026-10-23T22:30:00Z');

    for (const zone of ZONES) {
      inProcessZone(zone, () => {
        expect(startOfBusinessDay(evening).toISOString()).toBe('2026-10-22T23:00:00.000Z');
        expect(businessDateOf(evening)).toBe('2026-10-23');
        expect(startOfBusinessMonth(evening).toISOString()).toBe('2026-09-30T23:00:00.000Z');
        expect(businessYearMonth(evening)).toEqual({ year: 2026, month: 10 });
        expect(businessClock(evening)).toBe('23:30');
      });
    }
  });

  it('the first hour of the day belongs to the day', () => {
    // 00:30 in Tunis is 23:30 UTC the day before: a "today" that began at UTC midnight would leave it out.
    const justAfterMidnight = new Date('2026-10-23T23:30:00Z');

    for (const zone of ZONES) {
      inProcessZone(zone, () => {
        const start = startOfBusinessDay(justAfterMidnight);

        expect(start.toISOString()).toBe('2026-10-23T23:00:00.000Z');
        expect(start.getTime() <= justAfterMidnight.getTime()).toBe(true);
        expect(businessDateOf(justAfterMidnight)).toBe('2026-10-24');
      });
    }
  });

  it('a plain date is the day itself, midnight to midnight, and an instant is the day it falls in', () => {
    for (const zone of ZONES) {
      inProcessZone(zone, () => {
        const day = businessDayWindow('2026-10-23')!;

        expect(day.date).toBe('2026-10-23');
        expect(day.start.toISOString()).toBe('2026-10-22T23:00:00.000Z');
        expect(day.end.toISOString()).toBe('2026-10-23T23:00:00.000Z');

        expect(businessDayWindow('2026-10-23T22:59:59Z')!.date).toBe('2026-10-23');
        expect(businessDayWindow('2026-10-23T23:00:00Z')!.date).toBe('2026-10-24');
        expect(businessDayWindow(new Date('2026-10-23T09:00:00Z'))!.start.toISOString()).toBe('2026-10-22T23:00:00.000Z');
      });
    }

    expect(businessDayWindow('not a date')).toBeNull();
    expect(businessDayWindow('2026-13-45')).toBeNull();
    expect(businessDayWindow('')).toBeNull();
    expect(businessDayWindow(new Date('nope'))).toBeNull();
  });

  it('an appointment at 09:00 Tunis time sits inside the availability set at 09:00 Tunis time', () => {
    for (const zone of ZONES) {
      inProcessZone(zone, () => {
        const nine = zonedInstant('2026-10-23', '09:00', 'Africa/Tunis')!;
        const window = businessDayWindow('2026-10-23')!;

        expect(nine.toISOString()).toBe('2026-10-23T08:00:00.000Z');
        expect(nine.getTime() >= window.start.getTime() && nine.getTime() < window.end.getTime()).toBe(true);
        expect(businessClock(nine)).toBe('09:00');
      });
    }
  });

  it('follows the time zone of the settings', () => {
    applyLocale({ timezone: 'America/New_York' });

    // Summer time in New York: UTC-4 on 23 Oct 2026.
    expect(businessDateOf(new Date('2026-10-23T02:00:00Z'))).toBe('2026-10-22');
    expect(startOfBusinessDay(new Date('2026-10-23T12:00:00Z')).toISOString()).toBe('2026-10-23T04:00:00.000Z');
    expect(businessClock(new Date('2026-10-23T12:00:00Z'))).toBe('08:00');
  });

  it('a day with a change of clock is not 24 hours long', () => {
    // New York leaves summer time on Sunday 1 Nov 2026: that day has 25 hours.
    const day = businessDayWindow('2026-11-01', 'America/New_York')!;

    expect((day.end.getTime() - day.start.getTime()) / 3_600_000).toBe(25);
    expect(day.start.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(day.end.toISOString()).toBe('2026-11-02T05:00:00.000Z');
  });

  it('months: from the first instant to the last millisecond, on the business clock', () => {
    for (const zone of ZONES) {
      inProcessZone(zone, () => {
        const october = businessMonthRange(2026, 10);

        expect(october.from.toISOString()).toBe('2026-09-30T23:00:00.000Z');
        expect(october.to.toISOString()).toBe('2026-10-31T22:59:59.999Z');

        const december = businessMonthRange(2026, 12);

        expect(december.from.toISOString()).toBe('2026-11-30T23:00:00.000Z');
        expect(december.to.toISOString()).toBe('2026-12-31T22:59:59.999Z');
      });
    }

    expect(() => businessMonthRange(2026, 13)).toThrow('not a month');
  });

  it('counts the next day across the end of a month and of a year', () => {
    expect(nextDate('2026-10-31')).toBe('2026-11-01');
    expect(nextDate('2026-12-31')).toBe('2027-01-01');
    expect(nextDate('2028-02-28')).toBe('2028-02-29');
    expect(nextDate('2026-02-28')).toBe('2026-03-01');
    expect(() => nextDate('x')).toThrow('YYYY-MM-DD');
  });
});

describe('a moment sent by a client (P2-01)', () => {
  beforeEach(() => resetLocale());

  it('with a Z or an offset it is exact, whatever the clock of the server is', () => {
    for (const zone of ZONES) {
      inProcessZone(zone, () => {
        expect(instantOf('2026-10-26T08:00:00.000Z').toISOString()).toBe('2026-10-26T08:00:00.000Z');
        expect(instantOf('2026-10-26T09:00:00+01:00').toISOString()).toBe('2026-10-26T08:00:00.000Z');
        expect(instantOf(new Date('2026-10-26T08:00:00.000Z')).toISOString()).toBe('2026-10-26T08:00:00.000Z');
      });
    }
  });

  it('without one it is the clock of the business: 09:00 is 08:00 UTC in Tunis, on any server', () => {
    for (const zone of ZONES) {
      inProcessZone(zone, () => {
        expect(instantOf('2026-10-26T09:00:00').toISOString()).toBe('2026-10-26T08:00:00.000Z');
        expect(instantOf('2026-10-26 09:00').toISOString()).toBe('2026-10-26T08:00:00.000Z');
        expect(instantOf('2026-10-26T09:00:30').toISOString()).toBe('2026-10-26T08:00:30.000Z');
      });
    }
  });

  it('follows the time zone of the settings', () => {
    applyLocale({ timezone: 'Asia/Dubai' });
    expect(instantOf('2026-10-26T09:00:00').toISOString()).toBe('2026-10-26T05:00:00.000Z');
    expect(instantOf('2026-10-26T09:00:00', 'Africa/Tunis').toISOString()).toBe('2026-10-26T08:00:00.000Z');
  });

  it('a date or an hour that does not exist is not a moment', () => {
    expect(Number.isNaN(instantOf('2026-02-31T09:00:00').getTime())).toBe(true);
    expect(Number.isNaN(instantOf('2026-13-01T09:00:00').getTime())).toBe(true);
    expect(Number.isNaN(instantOf('2026-10-26T24:00').getTime())).toBe(true);
    expect(Number.isNaN(instantOf('not a date').getTime())).toBe(true);
    // 02:30 on 8 March 2026 was skipped in New York by the change of the clock.
    expect(Number.isNaN(instantOf('2026-03-08T02:30:00', 'America/New_York').getTime())).toBe(true);
  });
});

describe('a day whose clock skips midnight (P2-01)', () => {
  it('starts at 01:00, not at 23:00 the evening before', () => {
    // Havana puts its clocks forward at 00:00 on 8 March 2026: UTC-5 becomes UTC-4, and 00:00 does not exist.
    const day = businessDayWindow('2026-03-08', 'America/Havana')!;

    expect(day.start.toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(day.end.toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect((day.end.getTime() - day.start.getTime()) / 3_600_000).toBe(23);

    const before = businessDayWindow('2026-03-07', 'America/Havana')!;

    expect(before.end.toISOString()).toBe(day.start.toISOString());
  });

  it('an ordinary day, and the days of a zone with the change at night, are still 24 hours or what the clock makes them', () => {
    const paris = businessDayWindow('2026-10-25', 'Europe/Paris')!;

    expect((paris.end.getTime() - paris.start.getTime()) / 3_600_000).toBe(25);

    const tunis = businessDayWindow('2026-10-25', 'Africa/Tunis')!;

    expect((tunis.end.getTime() - tunis.start.getTime()) / 3_600_000).toBe(24);
  });
});
