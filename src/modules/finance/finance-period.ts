/**
 * The period of a finance screen (P2-08): days of the business clock (Africa/Tunis), both ends included.
 *
 * An accountant reconciles "the week of 19 to 25 October": the 19th from its first instant and the 25th to its last, on the
 * clock of the company and not of the server. The period is a pair of days, written 2026-10-19, and turned into the window
 * [start, end) of instants that a query needs.
 */
import { BadRequestException } from '@nestjs/common';

import { businessDateOf, businessDayWindow, isCalendarDate } from '../../common/locale/business-time';

/** The longest period a screen reads (a quarter): one answer is built from every payment of the period. */
export const MAX_PERIOD_DAYS = 93;

/** What a screen shows when it names no period: the last seven days, today included. */
export const DEFAULT_PERIOD_DAYS = 7;

export interface FinancePeriod {
  /** First day, YYYY-MM-DD. */
  from: string;
  /** Last day, YYYY-MM-DD. */
  to: string;
  /** Midnight at the start of the first day. */
  start: Date;
  /** Midnight at the start of the day after the last one: the period is [start, end). */
  end: Date;
  /** Every day of the period, in order. */
  days: string[];
  /** Whether the caller wrote the period (a list that is "everything waiting" has none unless it is asked for). */
  explicit: boolean;
}

/** The day `count` days after (or, negative, before) a day. */
export function shiftDay(day: string, count: number): string {
  const [year, month, date] = day.split('-').map(Number);
  const moved = new Date(0);

  moved.setUTCFullYear(year, month - 1, date + count);

  return `${String(moved.getUTCFullYear()).padStart(4, '0')}-${String(moved.getUTCMonth() + 1).padStart(2, '0')}-${String(moved.getUTCDate()).padStart(2, '0')}`;
}

/** The number of days from `from` to `to`, both included (the same day is 1). */
function daysBetween(from: string, to: string): number {
  const at = (day: string) => {
    const [year, month, date] = day.split('-').map(Number);
    const probe = new Date(0);

    probe.setUTCFullYear(year, month - 1, date);

    return Math.round(probe.getTime() / 86_400_000);
  };

  return at(to) - at(from) + 1;
}

/**
 * The period of a call. Neither end: the last seven days. Only the end: the seven days that end on it. Only the start: the seven
 * days that begin on it. Both: as written, but never longer than MAX_PERIOD_DAYS and never backwards. A day that is not a day of
 * the calendar (the 31st of November) is a bad request, not a quiet move to the next month.
 */
export function periodOf(from?: string | null, to?: string | null, now: Date = new Date()): FinancePeriod {
  const written = (value: string | null | undefined, which: string) => {
    if (value === undefined || value === null || value === '') return null;

    if (!isCalendarDate(value)) throw new BadRequestException(`La date « ${which} » n’est pas un jour du calendrier (AAAA-MM-JJ).`);

    return value;
  };

  const first = written(from, 'du');
  const last = written(to, 'au');
  const explicit = first !== null || last !== null;

  const end = last ?? (first ? shiftDay(first, DEFAULT_PERIOD_DAYS - 1) : businessDateOf(now));
  const start = first ?? shiftDay(end, -(DEFAULT_PERIOD_DAYS - 1));

  if (start > end) throw new BadRequestException('Période invalide : le premier jour est après le dernier.');

  const length = daysBetween(start, end);

  if (length > MAX_PERIOD_DAYS) throw new BadRequestException(`La période ne peut pas dépasser ${MAX_PERIOD_DAYS} jours.`);

  const startWindow = businessDayWindow(start);
  const endWindow = businessDayWindow(end);

  if (!startWindow || !endWindow) throw new BadRequestException('Période invalide.');

  return {
    from: start,
    to: end,
    start: startWindow.start,
    end: endWindow.end,
    days: Array.from({ length }, (_, index) => shiftDay(start, index)),
    explicit,
  };
}
