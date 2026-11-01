import { STATUS_GROUPS, canonicalStatus } from '../../modules/intervention-workflow/intervention-status';
import { OPEN_CANONICAL } from '../../modules/mission-actions/open-job';

/**
 * The rules about offering a job to several technicians at once (P3-07), all of them pure so that a test can pin each number and each sentence:
 *
 *   - how many technicians are asked at once, and for how long they may answer;
 *   - which offers are live (still waiting for an answer), and what an offer is called when it is read;
 *   - whether a job is reserved for the technicians it was offered to.
 *
 * Settings (both optional, a value out of its range is ignored and the default is used):
 *
 *   OFFER_MINUTES   how long an offer lasts, 1 to 120 (default 10)
 *   OFFER_COUNT     how many technicians a round asks, 1 to 10 (default 5)
 */

export const DEFAULT_OFFER_MINUTES = 10;
export const MIN_OFFER_MINUTES = 1;
export const MAX_OFFER_MINUTES = 120;

export const DEFAULT_OFFER_COUNT = 5;
export const MIN_OFFER_COUNT = 1;
export const MAX_OFFER_COUNT = 10;

/** An offer that ended stays in the technician's list this long (hours), so that "withdrawn" and "expired" can be read, then it is not listed any more. */
export const RECENT_OFFER_HOURS = 24;

/** The most offers one technician's list carries (the live ones and the recent ones). */
export const MAX_OFFERS_LISTED = 50;

type Env = Record<string, unknown>;

export interface OfferConfig {
  minutes: number;
  count: number;
}

function integerSetting(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  const value = typeof raw === 'string' && /^\s*\d+\s*$/.test(raw) ? Number(raw) : typeof raw === 'number' ? raw : Number.NaN;

  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

export function readOfferConfig(env: Env = process.env): OfferConfig {
  return {
    minutes: integerSetting(env, 'OFFER_MINUTES', DEFAULT_OFFER_MINUTES, MIN_OFFER_MINUTES, MAX_OFFER_MINUTES),
    count: integerSetting(env, 'OFFER_COUNT', DEFAULT_OFFER_COUNT, MIN_OFFER_COUNT, MAX_OFFER_COUNT),
  };
}

// ==========================================================
// What the back office asks for
// ==========================================================

/** `field` names what is out of range; the sentence that says so is the caller's (it is read by the dispatcher, in French, and has an Arabic copy). */
export type OfferRequest = { ok: true; count: number; minutes: number } | { ok: false; field: 'count' | 'minutes' };

/** A whole number that was sent as a number or as digits; anything else is not one. */
function wholeNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  if (typeof value === 'string' && /^\s*\d+\s*$/.test(value)) return Number(value);

  return null;
}

/**
 * The round the back office asks for: nothing sent means the settings; a number outside its range is refused, not corrected (a dispatcher who
 * typed 50 should be told, not given 10).
 */
export function offerRequest(body: { count?: unknown; minutes?: unknown } | null | undefined, config: OfferConfig = readOfferConfig()): OfferRequest {
  const sent = body ?? {};
  const count = sent.count === undefined || sent.count === null ? config.count : wholeNumber(sent.count);
  const minutes = sent.minutes === undefined || sent.minutes === null ? config.minutes : wholeNumber(sent.minutes);

  if (count === null || count < MIN_OFFER_COUNT || count > MAX_OFFER_COUNT) return { ok: false, field: 'count' };
  if (minutes === null || minutes < MIN_OFFER_MINUTES || minutes > MAX_OFFER_MINUTES) return { ok: false, field: 'minutes' };

  return { ok: true, count, minutes };
}

// ==========================================================
// Live and ended offers
// ==========================================================

export type OfferStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED' | 'WITHDRAWN';
export type OfferWithdrawal = 'TAKEN' | 'ASSIGNED' | 'CANCELLED' | 'STAFF';

/** What the technician is shown: `open` is the only state in which the offer can still be answered. */
export type OfferState = 'open' | 'accepted' | 'declined' | 'expired' | 'withdrawn';

/** Why a withdrawn offer was withdrawn, in the words the app picks a sentence by. `closed`: the job is not open any more and nobody recorded why. */
export type OfferBecause = 'taken' | 'assigned' | 'cancelled' | 'staff' | 'closed';

const BECAUSE: Record<OfferWithdrawal, OfferBecause> = {
  TAKEN: 'taken',
  ASSIGNED: 'assigned',
  CANCELLED: 'cancelled',
  STAFF: 'staff',
};

const timeOf = (value: Date | string | number | null | undefined): number | null => {
  if (value === null || value === undefined) return null;

  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();

  return Number.isFinite(time) ? time : null;
};

/**
 * An offer is live when nobody has answered it and its time has not run out. The instant it runs out is no longer live (an offer that expires
 * at 10:00:00 is gone at 10:00:00), and an offer with no readable time is not live: it must never reserve a job for ever.
 */
export function isLiveOffer(offer: { status: unknown; expiresAt: Date | string | number | null | undefined }, now: Date = new Date()): boolean {
  if (String(offer.status) !== 'PENDING') return false;

  const expires = timeOf(offer.expiresAt);

  return expires !== null && expires > now.getTime();
}

/**
 * Whether a job can still be offered or taken from an offer: it waits for a technician. A job that carries the id of a technician but waits in
 * the queue again is open (the id is a leftover); a job in the hands of a technician, finished or cancelled is not, whatever its `artisanId`.
 */
export function isOfferable(job: { status?: unknown } | null | undefined): boolean {
  if (!job) return false;

  const status = canonicalStatus(String(job.status));

  // The statuses in which a job waits for a technician (the same list as the board and the taking of an open job): the only ones in which an offer of it means anything.
  return status !== null && OPEN_CANONICAL.includes(status);
}

/** The word the app picks a sentence by, for a recorded reason (none recorded: the job is simply not open any more). */
export const becauseOf = (reason: OfferWithdrawal | null): OfferBecause => (reason ? BECAUSE[reason] : 'closed');

/**
 * Why the offers of a job that is no longer open end, when nobody recorded it (the sweep writes them a minute later): a cancelled job is cancelled,
 * a job in the hands of a technician was taken, and any other job that left the queue (a quote sent, a dispute, put on hold) has no reason to give:
 * the offer is read as "not available any more", as it was before the sweep wrote it.
 */
export function closureReason(job: { status?: unknown; artisanId?: number | null } | null | undefined): OfferWithdrawal | null {
  const status = canonicalStatus(String(job?.status));

  if (status === 'CANCELLED') return 'CANCELLED';

  return job?.artisanId && status !== null && (STATUS_GROUPS.active as readonly string[]).includes(status) ? 'TAKEN' : null;
}

export interface OfferRow {
  status: unknown;
  expiresAt: Date | string | number | null | undefined;
  withdrawnReason?: unknown;
}

export interface ReadOffer {
  state: OfferState;
  /** Only for a withdrawn offer. */
  because: OfferBecause | null;
}

/**
 * What an offer is called when it is read. Written down, ended offers say what they are; a PENDING offer is read against the job and the clock,
 * because the sweep that writes the end of an offer runs once a minute and the technician must not be shown an offer that has already ended:
 * a job that is not open any more makes it withdrawn, a time that has passed makes it expired.
 */
export function readOffer(offer: OfferRow, job: { status?: unknown } | null | undefined, now: Date = new Date()): ReadOffer {
  switch (String(offer.status)) {
    case 'ACCEPTED':
      return { state: 'accepted', because: null };
    case 'DECLINED':
      return { state: 'declined', because: null };
    case 'EXPIRED':
      return { state: 'expired', because: null };
    case 'WITHDRAWN':
      return { state: 'withdrawn', because: BECAUSE[String(offer.withdrawnReason) as OfferWithdrawal] ?? 'closed' };
    case 'PENDING':
      break;
    default:
      return { state: 'withdrawn', because: 'closed' };
  }

  if (!isOfferable(job)) return { state: 'withdrawn', because: 'closed' };

  return isLiveOffer(offer, now) ? { state: 'open', because: null } : { state: 'expired', because: null };
}

/**
 * Whether the job is reserved against a technician: some offer of it is live and none of the live ones is theirs. A job with no live offer is open
 * to every technician it fits, as it was before offers existed.
 */
export function reservedAgainst(liveOffers: Array<{ artisanId: number }>, userId: number): boolean {
  return liveOffers.length > 0 && !liveOffers.some((offer) => offer.artisanId === userId);
}

/** The instant an offer made now lasts until. */
export function offerExpiry(now: Date, minutes: number): Date {
  return new Date(now.getTime() + minutes * 60_000);
}

/** How long an ended offer is still listed, as the earliest `respondedAt`/`expiresAt` instant that is. */
export function recentSince(now: Date): Date {
  return new Date(now.getTime() - RECENT_OFFER_HOURS * 3_600_000);
}

/** An offer as the technician it was made to reads it: what it is called and when, never the rank, the score or the other technicians asked. */
export function offerView(
  offer: OfferRow & { id: number; interventionId: number; offeredAt?: Date | string | null; respondedAt?: Date | string | null },
  job: { status?: unknown } | null | undefined,
  now: Date = new Date(),
) {
  const read = readOffer(offer, job, now);

  return {
    id: offer.id,
    interventionId: offer.interventionId,
    state: read.state,
    because: read.because,
    offeredAt: offer.offeredAt ?? null,
    expiresAt: offer.expiresAt ?? null,
    respondedAt: offer.respondedAt ?? null,
  };
}
