/**
 * Days, months and clocks of the business (P2-01): always on the wall clock of the business time zone
 * (Africa/Tunis unless the company settings say otherwise), never on the clock of the server.
 *
 * `new Date().setHours(0, 0, 0, 0)` is midnight where the process runs: on a server in UTC it is 01:00 in Tunis, and a
 * "today" that starts at 01:00 leaves out the first hour of the day. These functions answer for the zone of the company
 * whatever the TZ of the process is.
 */
import { formatLocalTime, localMoment, zonedInstant } from '../availability/weekly-schedule';
import { getBusinessTimeZone } from '../../config/env';

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Is this YYYY-MM-DD a day of the calendar (not the 45th of the 13th month)? */
export function isCalendarDate(date: string): boolean {
  const match = DAY.exec(date);

  if (!match) return false;

  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  // setUTCFullYear, not Date.UTC: the year 50 is the year 50, not 1950.
  const probe = new Date(0);

  probe.setUTCFullYear(year, month - 1, day);

  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

/** "2026-10-19T09:00" or "2026-10-19 09:00:30": a date and a time with no zone or offset. */
const WITHOUT_OFFSET = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::([0-5]\d)(?:\.\d+)?)?$/;

/**
 * "2026-02-31" is not a date, but the JavaScript parser turns it into the 3rd of March
 * without a word, and an appointment would be booked on a day nobody asked for.
 */
function hasRealCalendarDate(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);

  if (!match) return true;

  return isCalendarDate(`${match[1]}-${match[2]}-${match[3]}`);
}

/**
 * A moment as sent by a client. With a "Z" or an offset it is exact. Without one it is the clock of the business (the
 * same clock the weekly hours are read on), not the clock of whichever machine the server runs on: `new Date("2026-10-26T09:00:00")`
 * is 09:00 in the zone of the process, which is 10:00 in Tunis on a server in UTC. A date that does not exist, or a time that
 * does not exist on that clock, is not a moment: an invalid Date, and the caller answers 400.
 */
export function instantOf(value: unknown, timeZone: string = getBusinessTimeZone()): Date {
  if (value instanceof Date) return value;

  const text = String(value).trim();

  if (!hasRealCalendarDate(text)) return new Date(Number.NaN);

  const local = WITHOUT_OFFSET.exec(text);

  if (!local) return new Date(text);

  const instant = zonedInstant(local[1], local[2], timeZone);

  if (!instant) return new Date(Number.NaN);

  // Read back on the clock of the business: it must show what was written ("24:00", or an
  // hour that a change of the clock skipped, would show another day or another hour).
  const shown = localMoment(instant, timeZone);

  if (shown.date !== local[1] || shown.time !== local[2]) return new Date(Number.NaN);

  return new Date(instant.getTime() + Number(local[3] ?? 0) * 1000);
}

/**
 * The first instant of a calendar day on the clock of the zone. At midnight, a zone that puts its clocks forward skips
 * 00:00 (Havana, Santiago): the day then starts at 01:00, and a plain "00:00" would land on the evening before.
 */
function startOfDay(date: string, timeZone: string): Date | null {
  const start = zonedInstant(date, '00:00', timeZone);

  if (!start) return null;

  let instant = start.getTime();

  for (let step = 0; step < 16 && localMoment(new Date(instant), timeZone).date < date; step += 1) instant += 15 * 60_000;

  return new Date(instant);
}

/** YYYY-MM-DD of the next calendar day. */
export function nextDate(date: string): string {
  const match = DAY.exec(date);

  if (!match) throw new Error(`${date} is not a YYYY-MM-DD date`);

  const next = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1));

  return next.toISOString().slice(0, 10);
}

/** The calendar day (YYYY-MM-DD) on the clock of the business at this instant. */
export function businessDateOf(at: Date = new Date(), timeZone: string = getBusinessTimeZone()): string {
  return localMoment(at, timeZone).date;
}

export interface DayWindow {
  /** YYYY-MM-DD on the clock of the business. */
  date: string;
  /** Midnight at the start of the day; the day is [start, end). */
  start: Date;
  /** Midnight at the start of the next day: a day with a change of clock is not 24 hours long. */
  end: Date;
}

/**
 * The window of a day: from a plain date ("2026-10-23", the day itself) or from an instant (the day it falls in on the
 * business clock). Null when it is neither.
 */
export function businessDayWindow(day: string | Date, timeZone: string = getBusinessTimeZone()): DayWindow | null {
  let date: string;

  if (typeof day === 'string' && DAY.test(day.trim())) {
    date = day.trim();

    if (!isCalendarDate(date)) return null;
  } else {
    const instant = day instanceof Date ? day : new Date(day);

    if (Number.isNaN(instant.getTime())) return null;

    date = businessDateOf(instant, timeZone);
  }

  const start = startOfDay(date, timeZone);
  const end = start ? startOfDay(nextDate(date), timeZone) : null;

  return start && end ? { date, start, end } : null;
}

export function startOfBusinessDay(at: Date = new Date(), timeZone: string = getBusinessTimeZone()): Date {
  return businessDayWindow(at, timeZone)!.start;
}

/** Midnight at the start of the first day of the month the instant falls in, on the business clock. */
export function startOfBusinessMonth(at: Date = new Date(), timeZone: string = getBusinessTimeZone()): Date {
  const [year, month] = businessDateOf(at, timeZone).split('-');

  return startOfDay(`${year}-${month}-01`, timeZone)!;
}

/** The year and the month (1 to 12) on the business clock. */
export function businessYearMonth(at: Date = new Date(), timeZone: string = getBusinessTimeZone()): { year: number; month: number } {
  const [year, month] = businessDateOf(at, timeZone).split('-').map(Number);

  return { year, month };
}

/** "09:05", for a message to a person. */
export function businessClock(at: Date = new Date(), timeZone: string = getBusinessTimeZone()): string {
  return formatLocalTime(at, timeZone);
}

/** The first instant of the month and the last millisecond of it, on the business clock (month 1 to 12). */
export function businessMonthRange(year: number, month: number, timeZone: string = getBusinessTimeZone()): { from: Date; to: Date } {
  if (!Number.isInteger(year) || year < 1 || year > 9999 || !Number.isInteger(month) || month < 1 || month > 12) throw new Error(`${year}-${month} is not a month`);

  const first = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;
  const following = month === 12 ? `${String(year + 1).padStart(4, '0')}-01-01` : `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-01`;
  const from = startOfDay(first, timeZone);
  const next = startOfDay(following, timeZone);

  if (!from || !next) throw new Error(`${year}-${month} is not a month`);

  return { from, to: new Date(next.getTime() - 1) };
}
