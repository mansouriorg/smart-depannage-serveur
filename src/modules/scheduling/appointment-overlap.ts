import { ConflictException } from '@nestjs/common';

import { ACTIVE_APPOINTMENT_STATUSES } from '../assignment/artisan-availability';

/**
 * Two visits of one artisan at the same time, refused by the database itself (P3-01).
 *
 * Every writer of a visit's time takes the artisan's lock and looks for a clash first (`checkDoubleBooking`, the availability
 * check of the assignment). That holds as long as every writer does: a script, a future route or a hand-written statement that
 * forgets the lock would book the same artisan twice, and nothing would say so. The exclusion constraint below is the last
 * line: PostgreSQL refuses the second row whatever wrote it.
 *
 * Prisma's schema cannot say it, so it is applied by `npm run scheduling:constraints` (the plan is made here, so that it is
 * tested). It needs the `btree_gist` extension, and it cannot be created while two visits of an artisan already overlap: the
 * script lists them, and nothing is applied until they are settled.
 */

export const APPOINTMENT_OVERLAP_CONSTRAINT = 'Appointment_artisan_no_overlap';

/** What the person sees when the second booking is refused. */
export const OVERLAP_MESSAGE = 'Ce créneau vient d’être pris pour cet artisan. Choisissez un autre horaire.';

/** The state of a visit that holds the calendar of its artisan: the same list the clash check reads. */
const HOLDING = ACTIVE_APPOINTMENT_STATUSES.map((status) => `'${status}'`).join(', ');

/**
 * The statements that create the constraint. Time ranges are half open (`[)`): a visit that ends when the next one starts does not
 * clash, as in `checkDoubleBooking`. Only a visit that holds the calendar counts (not a cancelled one, nor one that was not given a
 * time yet), and a row whose end is not after its start is left out instead of making the statement fail on old data.
 */
export function overlapConstraintStatements(): string[] {
  return [
    'CREATE EXTENSION IF NOT EXISTS btree_gist',
    [
      `ALTER TABLE "Appointment" ADD CONSTRAINT "${APPOINTMENT_OVERLAP_CONSTRAINT}"`,
      '  EXCLUDE USING gist ("artisanId" WITH =, tsrange("startsAt", "endsAt") WITH &&)',
      '  WHERE ("artisanId" IS NOT NULL AND "startsAt" IS NOT NULL AND "endsAt" IS NOT NULL AND "startsAt" < "endsAt"',
      `    AND "status" IN (${HOLDING}))`,
    ].join('\n'),
  ];
}

export type VisitRow = {
  id?: number;
  interventionId?: number;
  artisanId: number | null;
  startsAt: Date | string | null;
  endsAt: Date | string | null;
  status: string;
  /** The status of the job of the visit, when the script reads it: it tells a visit that took place from one that is still to come. */
  jobStatus?: string | null;
};

const time = (value: Date | string | null): number | null => {
  if (value === null || value === undefined) return null;

  const at = value instanceof Date ? value.getTime() : new Date(value).getTime();

  return Number.isNaN(at) ? null : at;
};

/** Whether a visit is one of those the constraint looks at (what its WHERE clause says). */
export function holdsTheCalendar(visit: VisitRow): boolean {
  const start = time(visit.startsAt);
  const end = time(visit.endsAt);

  return (
    visit.artisanId !== null &&
    visit.artisanId !== undefined &&
    start !== null &&
    end !== null &&
    start < end &&
    (ACTIVE_APPOINTMENT_STATUSES as readonly string[]).includes(String(visit.status))
  );
}

/** The constraint, as a rule: the same artisan, both visits holding the calendar, and the two hours cross. */
export function visitsClash(a: VisitRow, b: VisitRow): boolean {
  if (!holdsTheCalendar(a) || !holdsTheCalendar(b) || a.artisanId !== b.artisanId) return false;

  return (time(a.startsAt) as number) < (time(b.endsAt) as number) && (time(b.startsAt) as number) < (time(a.endsAt) as number);
}

/**
 * The pairs of visits that already clash: what stands in the way of the constraint. Visits are compared within one artisan (two artisans
 * never clash), so the work grows with the busiest calendar and not with the square of every visit there ever was.
 */
export function findClashingVisits<T extends VisitRow>(visits: readonly T[]): Array<[T, T]> {
  const pairs: Array<[T, T]> = [];
  const byArtisan = new Map<number, T[]>();

  for (const visit of visits.filter(holdsTheCalendar)) {
    const calendar = byArtisan.get(visit.artisanId as number) ?? [];

    calendar.push(visit);
    byArtisan.set(visit.artisanId as number, calendar);
  }

  for (const calendar of byArtisan.values()) {
    for (let i = 0; i < calendar.length; i += 1) {
      for (let j = i + 1; j < calendar.length; j += 1) {
        if (visitsClash(calendar[i], calendar[j])) pairs.push([calendar[i], calendar[j]]);
      }
    }
  }

  return pairs;
}

const EXCLUSION_VIOLATION = '23P01';

/**
 * Whether an error is the database refusing an overlap. The code comes in different places according to how the error travelled
 * (the driver's own error, Prisma's error with its `meta`, the adapter's `cause`), and the message names the constraint: all are looked at.
 */
export function isOverlapViolation(error: unknown): boolean {
  const seen = new Set<unknown>();

  const look = (value: unknown, depth: number): boolean => {
    if (!value || typeof value !== 'object' || depth > 4 || seen.has(value)) return false;

    seen.add(value);

    const record = value as Record<string, unknown>;

    for (const key of ['code', 'originalCode', 'sqlState']) {
      if (record[key] === EXCLUSION_VIOLATION) return true;
    }

    if (typeof record.constraint === 'string' && record.constraint === APPOINTMENT_OVERLAP_CONSTRAINT) return true;

    if (typeof record.message === 'string' && record.message.includes(APPOINTMENT_OVERLAP_CONSTRAINT)) return true;

    return ['meta', 'cause', 'driverAdapterError', 'originalError'].some((key) => look(record[key], depth + 1));
  };

  return look(error, 0);
}

/** An overlap the database refused is a clash for the person (409); any other error goes on as it is. */
export function overlapAsConflict(error: unknown): unknown {
  return isOverlapViolation(error) ? new ConflictException(OVERLAP_MESSAGE) : error;
}
