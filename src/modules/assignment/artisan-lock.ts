/**
 * One artisan's calendar changes one request at a time.
 *
 * "Is the artisan free for this hour?" and "book the hour" are two steps; two
 * requests that both see "free" would both book it. Every write that gives an
 * artisan some time (an assignment, the approval of a new time, a block of time the
 * artisan marks as unavailable) first takes this lock inside its transaction and
 * checks after taking it. A transaction-level lock (`xact`): the database lets it go
 * when the transaction ends, however it ends.
 */
export const LOCK_JOB = 71_001;
export const LOCK_ARTISAN = 71_002;

type RawDb = { $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown> };

export async function lockJob(tx: RawDb, interventionId: number): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_JOB}::int, ${interventionId}::int)`;
}

export async function lockArtisanCalendar(tx: RawDb, artisanId: number): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_ARTISAN}::int, ${artisanId}::int)`;
}
