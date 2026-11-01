/**
 * Actions the phone kept before it could send them (P3-06).
 *
 * A technician without a signal presses "arrived", "start", then takes the photo that closes the job; the phone keeps those, in order, and sends
 * them when the network is back. The server only sees them arrive. Without more, "arrived", "started" and "completed" would all carry the time of
 * their arrival (a few seconds apart, hours late), and a photo taken at 14:02 and sent at 17:40 would be flagged by the clock check as a phone whose
 * clock is three and a half hours wrong.
 *
 * So the phone says how long it held each action, in whole seconds, in the header `X-Queued-For`, counted on its own clock (a difference of two
 * readings of the same clock does not depend on whether that clock is right). The server dates the action at the moment it arrived minus that age.
 * Three guards keep the figure from being a way to write history:
 *
 *  - it is read leniently and never trusted far: a missing, empty, negative, fractional or unreadable value means "not held" (the time of arrival,
 *    as before this step), and a value above seven days counts as seven days;
 *  - an action is never dated before the moment of the one that came before it on the same job (arrived is not dated before on the way); and
 *  - never after its arrival.
 *
 * The time of arrival itself is still kept wherever the server keeps one (the proof's `receivedAt`, the events of the timeline).
 */

/** The header the phone adds to an action it held. */
export const QUEUED_FOR_HEADER = 'x-queued-for';

/** The longest an action may have been held: the phone drops what it could not send in that time, and so does the figure. */
export const MAX_QUEUED_FOR_SECONDS = 7 * 24 * 3600;

/** How long the phone says it held the action, in seconds: 0 when it says nothing readable. */
export function readQueuedFor(value: unknown): number {
  const text = typeof value === 'number' ? (Number.isSafeInteger(value) ? String(value) : '') : typeof value === 'string' ? value.trim() : '';

  // Digits only: no sign, no decimal, no exponent, no second value ("5, 7" is what two headers become).
  if (!/^\d{1,12}$/.test(text)) return 0;

  return Math.min(Number(text), MAX_QUEUED_FOR_SECONDS);
}

type Instant = Date | string | number | null | undefined;

function millis(value: Instant): number | null {
  if (value === null || value === undefined) return null;

  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();

  return Number.isNaN(time) ? null : time;
}

/**
 * When an action that reached the server at `receivedAt` was done: that moment minus the seconds the phone held it, but not before any of the
 * moments in `notBefore` (the earlier steps of the same job; those that are missing or are not dates are ignored) and never after `receivedAt`.
 */
export function whenDone(receivedAt: Date, queuedForSeconds: number, notBefore: ReadonlyArray<Instant> = []): Date {
  const received = receivedAt.getTime();
  const held = Number.isFinite(queuedForSeconds) ? Math.min(Math.max(0, Math.floor(queuedForSeconds)), MAX_QUEUED_FOR_SECONDS) : 0;

  if (held === 0) return new Date(received);

  let done = received - held * 1000;

  for (const earlier of notBefore) {
    const time = millis(earlier);

    // An earlier moment that is itself in the future of this arrival is nonsense (a clock set wrong on the server once): it holds nothing back.
    if (time !== null && time <= received && time > done) done = time;
  }

  return new Date(done);
}

/**
 * The dates that hold a held action in place: when the job was made and assigned, and when the artisan accepted it, set off, arrived and began the
 * work. An action the phone held is never dated before any of them (the first two matter when the road is short: the dashboard can assign a job as
 * accepted, and the status table lets a technician go from assigned straight to the work, so a step may have no road date to follow, and without a
 * floor "held for 7 days" would date it before the job existed). This file only names and reads them; the one writer of each is still where the
 * step is done (mission-actions, the staff workflow, the proof service for the end).
 */
export const ROAD_MOMENTS_SELECT = {
  createdAt: true,
  assignedAt: true,
  artisanAcceptedAt: true,
  artisanOnTheWayAt: true,
  artisanArrivedAt: true,
  workStartedAt: true,
} as const;

/** `whenDone` for an action on this job: not before any date of the road that the job row carries (a row without them holds nothing back). */
export function whenDoneOnJob(receivedAt: Date, queuedForSeconds: number, job: object | null | undefined): Date {
  const row = (job ?? {}) as Record<string, Instant>;

  return whenDone(
    receivedAt,
    queuedForSeconds,
    Object.keys(ROAD_MOMENTS_SELECT).map((key) => row[key]),
  );
}
