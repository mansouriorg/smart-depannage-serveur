/**
 * The weekly hours of an artisan ("Monday 08:00-17:00"), read in one place (P1-05).
 *
 * Matching an artisan to a job and scheduling a job used to carry their own copy
 * of this rule, and the two disagreed: a schedule with Monday to Friday only
 * counted as "free on Sunday" for the scheduling and "not free on Sunday" for the
 * matching, and both compared the slot hours with the UTC clock although the
 * artisans write them as the clock on their wall. Now there is one rule:
 *
 *  - no slot at all: the artisan never wrote a schedule, no restriction;
 *  - at least one slot (available or not): the schedule is the list of the
 *    available slots, and the appointment must fit inside one of them, on the day
 *    and in the hours of the business time zone (BUSINESS_TIMEZONE).
 */

export type WeeklySlot = {
  dayOfWeek: string;
  startTime: string;
  endTime: string;
  isAvailable: boolean;
};

export type LocalMoment = {
  /** MONDAY ... SUNDAY, the weekday where the business is */
  day: string;
  /** HH:mm on the clock where the business is */
  time: string;
  /** YYYY-MM-DD where the business is */
  date: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

const formatters = new Map<string, Intl.DateTimeFormat>();

export function localMoment(date: Date, timeZone: string): LocalMoment {
  let formatter = formatters.get(timeZone);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'long',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, formatter);
  }

  const parts: Record<string, string> = {};

  for (const part of formatter.formatToParts(date)) {
    parts[part.type] = part.value;
  }

  // Some runtimes write midnight as 24.
  const hour = parts.hour === '24' ? '00' : parts.hour;

  return {
    day: parts.weekday.toUpperCase(),
    time: `${hour}:${parts.minute}`,
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/**
 * The instant at which the wall clock of `timeZone` shows `date` (YYYY-MM-DD) at
 * `time` (HH:mm), or null when either is not a date or a time. This is how a time
 * somebody typed ("Monday 09:00") becomes the moment compared with the bookings.
 */
export function zonedInstant(date: string, time: string, timeZone: string): Date | null {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? '').trim());
  const minutes = minutesOfDay(time);

  if (!day || minutes === null) return null;

  const wanted = Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3])) + minutes * 60_000;

  if (Number.isNaN(wanted)) return null;

  // Read the clock at a first guess, then move by the difference; twice, so that a
  // change of the clock between the guess and the answer is followed.
  let instant = wanted;

  for (let pass = 0; pass < 2; pass += 1) {
    const shown = localMoment(new Date(instant), timeZone);
    const [year, month, dayOfMonth] = shown.date.split('-').map(Number);
    const shownMinutes = minutesOfDay(shown.time) as number;
    const shownAsUtc = Date.UTC(year, month - 1, dayOfMonth) + shownMinutes * 60_000;

    instant -= shownAsUtc - wanted;
  }

  return new Date(instant);
}

/** "18/10/2026 à 09:00", for a message to a person. */
export function formatLocalDateTime(date: Date, timeZone: string): string {
  const moment = localMoment(date, timeZone);
  const [year, month, day] = moment.date.split('-');

  return `${day}/${month}/${year} à ${moment.time}`;
}

/** "HH:mm" of this instant on the clock of the business. */
export function formatLocalTime(date: Date, timeZone: string): string {
  return localMoment(date, timeZone).time;
}

/** "08:00" -> 480, "24:00" -> 1440, anything that is not a time -> null. */
export function minutesOfDay(text: unknown): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());

  if (!match) return null;

  const minutes = Number(match[1]) * 60 + Number(match[2]);

  return Number(match[2]) < 60 && minutes <= 24 * 60 ? minutes : null;
}

export type ScheduleVerdict = {
  ok: boolean;
  /** false when the artisan has no schedule at all (nothing to restrict) */
  configured: boolean;
  reason: string;
};

export function checkWeeklySchedule(
  slots: readonly WeeklySlot[],
  startsAt: Date,
  endsAt: Date,
  timeZone: string,
): ScheduleVerdict {
  if (!slots.length) {
    return { ok: true, configured: false, reason: 'Aucun planning hebdomadaire configuré.' };
  }

  const start = localMoment(startsAt, timeZone);
  const end = localMoment(endsAt, timeZone);
  const startMinutes = minutesOfDay(start.time) as number;
  let endMinutes = minutesOfDay(end.time) as number;

  if (end.date !== start.date) {
    // A slot never crosses midnight; an end at midnight is the end of the day it started.
    const nextDay = Date.parse(`${end.date}T00:00:00Z`) - Date.parse(`${start.date}T00:00:00Z`) === DAY_MS;

    if (!(nextDay && endMinutes === 0)) {
      return { ok: false, configured: true, reason: 'Le créneau couvre deux jours.' };
    }

    endMinutes = 24 * 60;
  }

  const fits = slots.some((slot) => {
    if (!slot.isAvailable || String(slot.dayOfWeek).toUpperCase() !== start.day) return false;

    const from = minutesOfDay(slot.startTime);
    const to = minutesOfDay(slot.endTime);

    return from !== null && to !== null && from <= startMinutes && to >= endMinutes;
  });

  return fits
    ? { ok: true, configured: true, reason: 'Disponible sur ce créneau hebdomadaire.' }
    : { ok: false, configured: true, reason: 'Pas disponible sur ce créneau hebdomadaire.' };
}
