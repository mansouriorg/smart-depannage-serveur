import { ACTIVE_APPOINTMENT_STATUSES } from '../assignment/artisan-availability';

import {
  APPOINTMENT_OVERLAP_CONSTRAINT,
  VisitRow,
  findClashingVisits,
  overlapConstraintStatements,
} from './appointment-overlap';

/**
 * Puts the "no two visits of one artisan at the same time" constraint in the database (P3-01), or says what stands in the way.
 * Run by `npm run scheduling:constraints` (a dry run) and `npm run scheduling:constraints -- --apply`. It can be run again at any
 * time: a database that has the constraint is left alone. `prisma db push` is not made to know this constraint: run it again after a
 * push on a new database, and check on a copy of the database that your version of Prisma leaves the constraint in place.
 */

export type ConstraintDb = {
  $queryRawUnsafe: (sql: string, ...values: unknown[]) => Promise<any[]>;
  $executeRawUnsafe: (sql: string, ...values: unknown[]) => Promise<unknown>;
};

export type ConstraintReport = {
  /** The constraint stood already. */
  present: boolean;
  /** Pairs of visits that clash today: the constraint cannot be created until each is settled. */
  clashes: Array<[VisitRow, VisitRow]>;
  /** The constraint was created by this run. */
  applied: boolean;
  /** Nothing is in the way: present, or created, or (dry run) ready to be created. */
  ok: boolean;
  /** The database cannot create the `btree_gist` extension the constraint needs (the provider has not made it available). */
  missingExtension?: boolean;
  /** Visits still standing on a cancelled job (a cancellation that did not free them): how many there were. Only set when there were some. */
  standing?: number;
  /** Of those, how many this run handed to the cancellation (only with --apply; a visit that ended meanwhile is left as it is). */
  released?: number;
};

export async function ensureOverlapConstraint(options: {
  db: ConstraintDb;
  apply: boolean;
  log?: (line: string) => void;
  /**
   * The status of the jobs of the visits that clash, by id of job. It is what tells the person who settles a clash whether the visit took
   * place. It comes from the typed client of the caller (the job's table is never read with raw SQL here: a test forbids raw SQL on it).
   */
  jobStatuses?: (interventionIds: number[]) => Promise<Map<number, string>>;
  /**
   * Visits that still hold an artisan's hour on a job that is cancelled (a job cancelled before the cancellation freed its visit, or by a
   * route that did not). They hold no hour in fact, and they would stop the constraint: `find` lists the ids of those jobs and `release`
   * cancels their visits the way a cancellation does (requests closed, reminders dropped). Typed client of the caller, like `jobStatuses`.
   */
  visitsOfCancelledJobs?: {
    find: () => Promise<number[]>;
    release: (interventionIds: number[]) => Promise<void>;
  };
}): Promise<ConstraintReport> {
  const log = options.log ?? (() => undefined);

  const existing = await options.db.$queryRawUnsafe('SELECT 1 FROM pg_constraint WHERE conname = $1', APPOINTMENT_OVERLAP_CONSTRAINT);

  if (existing.length > 0) {
    log(`The constraint ${APPOINTMENT_OVERLAP_CONSTRAINT} is already there.`);

    return { present: true, clashes: [], applied: false, ok: true };
  }

  // A visit standing on a cancelled job holds no hour: it is cancelled first (with --apply), or left out of the count (dry run).
  const standingJobs = options.visitsOfCancelledJobs ? await options.visitsOfCancelledJobs.find() : [];
  let released = 0;

  if (standingJobs.length > 0) {
    if (options.apply && options.visitsOfCancelledJobs) {
      await options.visitsOfCancelledJobs.release(standingJobs);
      released = standingJobs.length;
      log(`${standingJobs.length} visit(s) were still standing on a cancelled job (job #${standingJobs.join(', #')}): they were cancelled, they hold no hour.`);
    } else {
      log(`${standingJobs.length} visit(s) still stand on a cancelled job (job #${standingJobs.join(', #')}): they hold no hour. Run with --apply to cancel them; they are not counted below.`);
    }
  }

  const standing = new Set(standingJobs);
  const extra = standingJobs.length > 0 ? { standing: standingJobs.length, ...(released > 0 ? { released } : {}) } : {};

  const statuses = ACTIVE_APPOINTMENT_STATUSES.map((status) => `'${status}'`).join(', ');
  const visits: VisitRow[] = (
    await options.db.$queryRawUnsafe(
      `SELECT a."id", a."interventionId", a."artisanId", a."startsAt", a."endsAt", a."status"::text AS "status" FROM "Appointment" a WHERE a."artisanId" IS NOT NULL AND a."startsAt" IS NOT NULL AND a."endsAt" IS NOT NULL AND a."status"::text IN (${statuses}) ORDER BY a."artisanId", a."startsAt"`,
    )
  ).map((row: any) => ({
    id: Number(row.id),
    interventionId: row.interventionId === null || row.interventionId === undefined ? undefined : Number(row.interventionId),
    artisanId: Number(row.artisanId),
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    status: String(row.status),
  }));

  const clashes = findClashingVisits(visits.filter((visit) => visit.interventionId === undefined || !standing.has(visit.interventionId)));

  // Only the visits that clash need their job: it says whether the visit took place.
  if (clashes.length > 0 && options.jobStatuses) {
    const ids = [...new Set(clashes.flat().map((visit) => visit.interventionId).filter((id): id is number => typeof id === 'number'))];
    const jobStatuses = await options.jobStatuses(ids);

    for (const visit of clashes.flat()) {
      visit.jobStatus = visit.interventionId === undefined ? null : (jobStatuses.get(visit.interventionId) ?? null);
    }
  }

  if (clashes.length > 0) {
    log(`${clashes.length} pair(s) of visits of one artisan overlap today. Settle each, then run this again:`);

    for (const [a, b] of clashes) {
      log(`  artisan #${a.artisanId}: appointment #${a.id} (${iso(a.startsAt)} → ${iso(a.endsAt)}, ${a.status}, job ${a.jobStatus ?? '?'}) and #${b.id} (${iso(b.startsAt)} → ${iso(b.endsAt)}, ${b.status}, job ${b.jobStatus ?? '?'})`);
    }

    log('A visit that took place (its job is finished and its hour is past) is not to be cancelled: set the status of that visit to COMPLETED, which frees its hour. A visit still to come is moved or cancelled.');

    return { present: false, clashes, applied: false, ok: false, ...extra };
  }

  // The constraint compares an artisan (equality) and a range (overlap) in one index: that is the extension's job. A database that does not
  // offer it cannot have the constraint, and the dry run must say so before anyone plans on it.
  const offered = await options.db.$queryRawUnsafe('SELECT 1 FROM pg_available_extensions WHERE name = $1', 'btree_gist');

  if (offered.length === 0) {
    log('No visits overlap, but this database does not offer the btree_gist extension, which the constraint needs. Ask the database provider to enable it (on a server you run, install the postgresql contrib package), then run this again.');

    return { present: false, clashes: [], applied: false, ok: false, missingExtension: true, ...extra };
  }

  if (!options.apply) {
    log('No visits overlap. The constraint would be created (run again with --apply).');

    return { present: false, clashes: [], applied: false, ok: true, ...extra };
  }

  for (const statement of overlapConstraintStatements()) {
    await options.db.$executeRawUnsafe(statement);
  }

  log(`The constraint ${APPOINTMENT_OVERLAP_CONSTRAINT} was created.`);

  return { present: false, clashes: [], applied: true, ok: true, ...extra };
}

function iso(value: Date | string | null): string {
  return value instanceof Date ? value.toISOString() : String(value);
}
