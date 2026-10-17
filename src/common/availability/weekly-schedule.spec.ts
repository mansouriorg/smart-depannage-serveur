import {
  checkWeeklySchedule,
  formatLocalDateTime,
  formatLocalTime,
  localMoment,
  minutesOfDay,
  zonedInstant,
} from './weekly-schedule';

const TUNIS = 'Africa/Tunis'; // UTC+1 all year

const slot = (dayOfWeek: string, startTime: string, endTime: string, isAvailable = true) => ({ dayOfWeek, startTime, endTime, isAvailable });

const weekdays = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'].map((day) => slot(day, '08:00', '17:00'));

const at = (iso: string) => new Date(iso);

describe('localMoment', () => {
  it('reads an instant on the clock of the business, not on the UTC clock', () => {
    // Sunday 18 October 2026, 23:30 UTC is already Monday 00:30 in Tunis
    expect(localMoment(at('2026-10-18T23:30:00Z'), TUNIS)).toEqual({ day: 'MONDAY', time: '00:30', date: '2026-10-19' });
    expect(localMoment(at('2026-10-19T07:00:00Z'), TUNIS)).toEqual({ day: 'MONDAY', time: '08:00', date: '2026-10-19' });
  });

  it('follows the summer time of another zone', () => {
    expect(localMoment(at('2026-07-15T10:00:00Z'), 'Europe/Paris').time).toBe('12:00');
    expect(localMoment(at('2026-01-15T10:00:00Z'), 'Europe/Paris').time).toBe('11:00');
  });

  it('midnight is 00:00, never 24:00', () => {
    expect(localMoment(at('2026-10-18T23:00:00Z'), TUNIS).time).toBe('00:00');
  });

  it('formats for a message', () => {
    expect(formatLocalDateTime(at('2026-10-19T07:00:00Z'), TUNIS)).toBe('19/10/2026 à 08:00');
    expect(formatLocalTime(at('2026-10-19T14:30:00Z'), TUNIS)).toBe('15:30');
  });
});

describe('minutesOfDay', () => {
  it('reads HH:mm, with or without a leading zero, and 24:00', () => {
    expect(minutesOfDay('08:00')).toBe(480);
    expect(minutesOfDay('8:05')).toBe(485);
    expect(minutesOfDay('24:00')).toBe(1440);
  });

  it('refuses what is not a time', () => {
    for (const value of ['', null, undefined, '25:00', '12:60', 'noon', '12', '8h30', '24:01']) {
      expect(minutesOfDay(value)).toBe(null);
    }
  });
});

describe('checkWeeklySchedule: one rule for matching and scheduling', () => {
  it('no slot at all: the artisan never wrote a schedule, so nothing restricts', () => {
    const verdict = checkWeeklySchedule([], at('2026-10-18T10:00:00Z'), at('2026-10-18T11:00:00Z'), TUNIS);

    expect(verdict.ok).toBe(true);
    expect(verdict.configured).toBe(false);
  });

  it('a schedule of Monday to Friday does not cover Sunday (the two services used to disagree here)', () => {
    const sunday = checkWeeklySchedule(weekdays, at('2026-10-18T09:00:00Z'), at('2026-10-18T10:00:00Z'), TUNIS);
    const monday = checkWeeklySchedule(weekdays, at('2026-10-19T09:00:00Z'), at('2026-10-19T10:00:00Z'), TUNIS);

    expect(sunday.ok).toBe(false);
    expect(sunday.configured).toBe(true);
    expect(monday.ok).toBe(true);
  });

  it('slots that are all marked unavailable mean "never", not "no schedule"', () => {
    const verdict = checkWeeklySchedule([slot('MONDAY', '08:00', '17:00', false)], at('2026-10-19T09:00:00Z'), at('2026-10-19T10:00:00Z'), TUNIS);

    expect(verdict.ok).toBe(false);
  });

  it('an unavailable slot never helps, an available one on the same day does', () => {
    const slots = [slot('MONDAY', '08:00', '17:00', false), slot('MONDAY', '09:00', '12:00')];

    expect(checkWeeklySchedule(slots, at('2026-10-19T08:30:00Z'), at('2026-10-19T09:30:00Z'), TUNIS).ok).toBe(true); // 09:30-10:30
    expect(checkWeeklySchedule(slots, at('2026-10-19T12:30:00Z'), at('2026-10-19T13:30:00Z'), TUNIS).ok).toBe(false); // 13:30-14:30
  });

  it('the hours are the hours on the wall of the business: 08:00 in Tunis is 07:00 UTC', () => {
    const open = (from: string, to: string) => checkWeeklySchedule(weekdays, at(from), at(to), TUNIS).ok;

    expect(open('2026-10-19T07:00:00Z', '2026-10-19T08:00:00Z')).toBe(true); // 08:00-09:00
    expect(open('2026-10-19T06:59:00Z', '2026-10-19T08:00:00Z')).toBe(false); // starts 07:59
    expect(open('2026-10-19T15:00:00Z', '2026-10-19T16:00:00Z')).toBe(true); // 16:00-17:00
    expect(open('2026-10-19T15:30:00Z', '2026-10-19T16:01:00Z')).toBe(false); // ends 17:01
  });

  it('the weekday is the weekday of the business: Sunday 23:30 UTC is Monday morning in Tunis', () => {
    const early = [slot('MONDAY', '00:00', '02:00')];

    expect(checkWeeklySchedule(early, at('2026-10-18T23:30:00Z'), at('2026-10-19T00:30:00Z'), TUNIS).ok).toBe(true);
  });

  it('a slot is not crossed by an appointment over midnight, but may end at midnight', () => {
    const night = [slot('MONDAY', '20:00', '24:00'), slot('TUESDAY', '00:00', '06:00')];

    expect(checkWeeklySchedule(night, at('2026-10-19T22:00:00Z'), at('2026-10-20T00:30:00Z'), TUNIS).ok).toBe(false); // 23:00 -> 01:30
    expect(checkWeeklySchedule(night, at('2026-10-19T21:00:00Z'), at('2026-10-19T23:00:00Z'), TUNIS).ok).toBe(true); // 22:00 -> 24:00
  });

  it('slot hours that are not hours are ignored, they cannot make an artisan free', () => {
    const verdict = checkWeeklySchedule([slot('MONDAY', 'morning', 'evening')], at('2026-10-19T09:00:00Z'), at('2026-10-19T10:00:00Z'), TUNIS);

    expect(verdict.ok).toBe(false);
  });

  it('the day name may be written in any case', () => {
    expect(checkWeeklySchedule([slot('monday', '08:00', '17:00')], at('2026-10-19T09:00:00Z'), at('2026-10-19T10:00:00Z'), TUNIS).ok).toBe(true);
  });
});

describe('zonedInstant: a time typed on the wall clock of the business', () => {
  it('reads 09:00 in Tunis (UTC+1, no summer time) as 08:00 UTC', () => {
    expect(zonedInstant('2026-10-19', '09:00', 'Africa/Tunis')?.toISOString()).toBe('2026-10-19T08:00:00.000Z');
    expect(zonedInstant('2026-07-19', '09:00', 'Africa/Tunis')?.toISOString()).toBe('2026-07-19T08:00:00.000Z');
  });

  it('follows summer time where there is one', () => {
    expect(zonedInstant('2026-07-15', '09:00', 'Europe/Paris')?.toISOString()).toBe('2026-07-15T07:00:00.000Z');
    expect(zonedInstant('2026-01-15', '09:00', 'Europe/Paris')?.toISOString()).toBe('2026-01-15T08:00:00.000Z');
  });

  it('is the identity in UTC and rolls 24:00 to the next day', () => {
    expect(zonedInstant('2026-10-19', '09:30', 'UTC')?.toISOString()).toBe('2026-10-19T09:30:00.000Z');
    expect(zonedInstant('2026-10-19', '24:00', 'UTC')?.toISOString()).toBe('2026-10-20T00:00:00.000Z');
  });

  it('is the inverse of localMoment', () => {
    const moment = zonedInstant('2026-10-19', '17:45', 'Africa/Tunis') as Date;

    expect(localMoment(moment, 'Africa/Tunis')).toEqual({ day: 'MONDAY', time: '17:45', date: '2026-10-19' });
  });

  it('refuses what is not a date or a time', () => {
    expect(zonedInstant('19/10/2026', '09:00', 'UTC')).toBeNull();
    expect(zonedInstant('2026-10-19', '9h', 'UTC')).toBeNull();
    expect(zonedInstant('', '', 'UTC')).toBeNull();
  });
});
