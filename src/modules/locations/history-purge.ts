import { withAliases } from '../intervention-workflow/intervention-status';

/**
 * The end of the history of positions (P3-05): positions older than the retention are deleted, except those of a job that is in
 * dispute. A route is kept for a few days because where a technician went is personal data; it is kept longer only where somebody
 * may still need it to settle a dispute: a job with a complaint that is not decided yet, or a job whose status is "disputed".
 * Once the complaint is decided the next round deletes the route, if it is older than the retention.
 */

/** The complaints that are not decided yet. */
export const OPEN_COMPLAINT_STATUSES = ['OPEN', 'IN_REVIEW', 'WAITING_CLIENT', 'WAITING_ARTISAN'] as const;

/** How many rows one delete takes: a big table is emptied in pieces, so that no round holds the table for long. */
export const PURGE_BATCH = 5_000;

/** The most pieces one round deletes (a safety stop: the rest goes the next day). */
export const PURGE_MAX_BATCHES = 200;

export interface PurgeResult {
  deleted: number;
  /** Jobs whose positions were kept because they are in dispute. */
  heldJobs: number;
  /** True when the round stopped at its safety limit with more to delete: the rest goes the next day, and it is worth a look if it happens twice. */
  cutShort: boolean;
}

export async function purgeLocationHistory(
  db: any,
  historyDays: number,
  now: Date = new Date(),
  limits: { batch?: number; maxBatches?: number } = {},
): Promise<PurgeResult> {
  const batchSize = limits.batch ?? PURGE_BATCH;
  const maxBatches = limits.maxBatches ?? PURGE_MAX_BATCHES;
  const cutoff = new Date(now.getTime() - historyDays * 24 * 60 * 60 * 1000);

  const [complaints, disputed] = await Promise.all([
    db.complaint.findMany({ where: { status: { in: [...OPEN_COMPLAINT_STATUSES] } }, select: { interventionId: true } }),
    db.intervention.findMany({ where: { status: { in: withAliases(['DISPUTED']) } }, select: { id: true } }),
  ]);

  const held = [...new Set<number>([...complaints.map((row: any) => row.interventionId), ...disputed.map((row: any) => row.id)].filter((id) => typeof id === 'number'))];

  // A position whose job was deleted has no job any more: it goes with the others at the end of the days kept. `notIn` does not match a
  // null (in SQL `NOT IN` is never true for one), so the null is named; and with no job to hold there is nothing to leave out.
  const where = { recordedAt: { lt: cutoff }, ...(held.length ? { OR: [{ interventionId: null }, { interventionId: { notIn: held } }] } : {}) };

  let deleted = 0;
  let cutShort = false;

  for (let round = 0; round < maxBatches; round += 1) {
    const batch = await db.artisanLocationPing.findMany({ where, select: { id: true }, orderBy: { id: 'asc' }, take: batchSize });

    if (batch.length === 0) break;

    const gone = await db.artisanLocationPing.deleteMany({ where: { id: { in: batch.map((row: any) => row.id) } } });

    deleted += gone.count;

    if (batch.length < batchSize) break;

    cutShort = round === maxBatches - 1;
  }

  return { deleted, heldJobs: held.length, cutShort };
}

/** The window of the daily round, in minutes after midnight, local time: from 03:30 up to (not including) 06:00. */
export const PURGE_WINDOW_FROM = 3 * 60 + 30;
export const PURGE_WINDOW_UNTIL = 6 * 60;

/**
 * Whether it is the time of the daily round in a time zone (from 03:30 to 05:59), and the local date it is then. Read at the moment the round
 * asks, so that the zone the owner set in the company settings (which are read after the server starts) is the one in force.
 *
 * It is a window, not a minute: the round is asked every quarter of an hour and runs at the first ask inside it, so that a server that was
 * restarting at 03:30, or a database that was away for a moment, does not lose the day. The service runs it once a day.
 */
export function purgeSlot(now: Date, timeZone: string): { day: string; due: boolean } {
  let parts: Intl.DateTimeFormatPart[];

  try {
    parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  } catch {
    // A zone name the runtime does not know: the round still runs once a day, in the default zone (and not at all if that is unknown too).
    return timeZone === 'Africa/Tunis' ? { day: '', due: false } : purgeSlot(now, 'Africa/Tunis');
  }

  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
  const minutesOfDay = Number(part('hour')) * 60 + Number(part('minute'));

  return { day: `${part('year')}-${part('month')}-${part('day')}`, due: minutesOfDay >= PURGE_WINDOW_FROM && minutesOfDay < PURGE_WINDOW_UNTIL };
}
