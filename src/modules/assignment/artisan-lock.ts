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

/**
 * The same kind of lock for one artisan's cash ledger and for one artisan's payouts (P2-02). "How much does the artisan
 * owe?" and "write the line" are two steps: two requests that both read the same balance would both be allowed to take it
 * off (a remittance larger than what is owed), and two payouts that both see a job as free would both pay it. The numbers
 * differ from the two above so that a ledger never waits for a calendar. A job is locked before an artisan's ledger.
 */
export const LOCK_CASH_LEDGER = 71_003;
export const LOCK_PAYOUT = 71_004;

/**
 * The numbers of the invoices and of the credit notes (P2-07): one lock per series and year, taken after the lock of the job
 * and held until the document is saved, so that two documents never get the same number and a document that fails to save
 * leaves its number to the next one.
 */
export const LOCK_DOCUMENT_NUMBER = 71_005;

type RawDb = { $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown> };

export async function lockJob(tx: RawDb, interventionId: number): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_JOB}::int, ${interventionId}::int)`;
}

export async function lockArtisanCalendar(tx: RawDb, artisanId: number): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_ARTISAN}::int, ${artisanId}::int)`;
}

export async function lockCashLedger(tx: RawDb, artisanId: number): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_CASH_LEDGER}::int, ${artisanId}::int)`;
}

export async function lockPayouts(tx: RawDb, artisanId: number): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_PAYOUT}::int, ${artisanId}::int)`;
}

export async function lockDocumentNumbers(tx: RawDb, key: number): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_DOCUMENT_NUMBER}::int, ${key}::int)`;
}
