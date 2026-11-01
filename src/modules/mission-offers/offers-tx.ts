import { isLiveOffer } from '../../common/offers/offer-rules';

/**
 * What the other modules do with the offers of a job, inside the transaction they already hold (P3-07). Every function here is called after the
 * lock of the job (`lockJob`) is taken, so two answers to the same job cannot interleave: the technician who takes a job, the back office that
 * gives it to somebody, and the technician who declines all go through the same line.
 *
 * The functions take the transaction client as `tx` and use no other module, so the mission actions, the assignment and the board can call them
 * without the offers module (and its notifications) having to be imported by them.
 */

type Tx = any;

export interface OfferHolder {
  id: number;
  artisanId: number;
}

/** The offers of a job that are live now: waiting for an answer and not run out. */
export async function liveOffersOf(tx: Tx, interventionId: number, now: Date = new Date()): Promise<OfferHolder[]> {
  const rows: Array<OfferHolder & { status: unknown; expiresAt: unknown }> = await tx.missionOffer.findMany({
    where: { interventionId, status: 'PENDING' },
    select: { id: true, artisanId: true, status: true, expiresAt: true },
  });

  // The clock is read here, not in the query: one rule (`isLiveOffer`) decides what is live, in the code and in the tests.
  return rows.filter((row) => isLiveOffer(row as any, now)).map((row) => ({ id: row.id, artisanId: row.artisanId }));
}

/**
 * A technician takes the job (from their offer, or from the board when no offer of it is live): their own offer is accepted, and every other offer
 * still waiting for an answer is withdrawn because the job was taken. An offer that had already run out (the sweep did not get to it yet) ends as
 * expired, not as withdrawn: it was not live when the job was taken, and the technician is not told a job was taken from under them.
 *
 * Returns the technicians whose live offer was withdrawn, to be told after the commit.
 */
export async function settleOffersOnTake(tx: Tx, params: { interventionId: number; winnerId: number; now: Date }): Promise<number[]> {
  return closePending(tx, { ...params, winnerId: params.winnerId, reason: 'TAKEN' });
}

/**
 * The back office gives the job to somebody (or calls the round off): every offer still waiting for an answer ends. `winnerId` is the technician
 * the job was given to, whose own offer (if they had one) counts as accepted; it is null when nobody got the job.
 */
export async function withdrawOffers(
  tx: Tx,
  params: { interventionId: number; reason: 'ASSIGNED' | 'CANCELLED' | 'STAFF'; now: Date; winnerId?: number | null },
): Promise<number[]> {
  return closePending(tx, { interventionId: params.interventionId, winnerId: params.winnerId ?? null, reason: params.reason, now: params.now });
}

async function closePending(
  tx: Tx,
  params: { interventionId: number; winnerId: number | null; reason: 'TAKEN' | 'ASSIGNED' | 'CANCELLED' | 'STAFF'; now: Date },
): Promise<number[]> {
  const { interventionId, winnerId, reason, now } = params;


  const pending: Array<OfferHolder & { status: unknown; expiresAt: unknown }> = await tx.missionOffer.findMany({
    where: { interventionId, status: 'PENDING' },
    select: { id: true, artisanId: true, status: true, expiresAt: true },
  });

  const told: number[] = [];

  for (const offer of pending) {
    if (winnerId !== null && offer.artisanId === winnerId) {
      await tx.missionOffer.update({ where: { id: offer.id }, data: { status: 'ACCEPTED', respondedAt: now } });
      continue;
    }

    if (isLiveOffer(offer as any, now)) {
      await tx.missionOffer.update({
        where: { id: offer.id },
        data: { status: 'WITHDRAWN', withdrawnReason: reason, respondedAt: now },
      });

      told.push(offer.artisanId);
    } else {
      await tx.missionOffer.update({ where: { id: offer.id }, data: { status: 'EXPIRED', respondedAt: now } });
    }
  }

  // After the offers still waiting were settled (so that the sweep, which does not take the lock, cannot slip a write in between).
  if (winnerId !== null) await reconcileHolder(tx, { interventionId, holderId: winnerId, reason: reason === 'TAKEN' ? 'TAKEN' : 'ASSIGNED', now });

  return told;
}

/**
 * Makes the rows of the offers agree with who holds the job once it has a holder (taken from the offers, from the board after the offers ended, or
 * given by the back office): the holder's own offer, if it had ended some other way (withdrawn when another technician took the job and gave it back,
 * run out, or declined before the back office gave them the job), says accepted; and the offer of the technician who held it before, which still said accepted, says withdrawn. Without this the list
 * of the back office and the technician's own list would tell "taken by another technician" to the one who is working on the job.
 */
async function reconcileHolder(tx: Tx, params: { interventionId: number; holderId: number; reason: 'TAKEN' | 'ASSIGNED'; now: Date }): Promise<void> {
  const { interventionId, holderId, reason, now } = params;

  const mine: { id: number } | null = await tx.missionOffer.findFirst({
    where: { interventionId, artisanId: holderId, status: { in: ['WITHDRAWN', 'EXPIRED', 'DECLINED'] } },
    select: { id: true },
  });

  if (mine) await tx.missionOffer.update({ where: { id: mine.id }, data: { status: 'ACCEPTED', withdrawnReason: null, respondedAt: now } });

  const before: Array<{ id: number }> = await tx.missionOffer.findMany({
    where: { interventionId, status: 'ACCEPTED', artisanId: { not: holderId } },
    select: { id: true },
  });

  for (const offer of before) {
    await tx.missionOffer.update({ where: { id: offer.id }, data: { status: 'WITHDRAWN', withdrawnReason: reason, respondedAt: now } });
  }
}

/**
 * A technician turns the offer down (the same action as refusing the job). Only an offer that is still waiting changes; a technician who
 * answers after the time ran out has an expired offer, not a declined one. A technician who gives back a job they had accepted from an offer
 * has declined it: their accepted offer says so.
 */
export async function declineOffer(tx: Tx, params: { interventionId: number; artisanId: number; now: Date }): Promise<boolean> {
  const { interventionId, artisanId, now } = params;

  const offer: (OfferHolder & { status: unknown; expiresAt: unknown }) | null = await tx.missionOffer.findFirst({
    where: { interventionId, artisanId, status: 'PENDING' },
    select: { id: true, artisanId: true, status: true, expiresAt: true },
  });

  if (!offer) {
    const accepted: { id: number } | null = await tx.missionOffer.findFirst({ where: { interventionId, artisanId, status: 'ACCEPTED' }, select: { id: true } });

    if (accepted) await tx.missionOffer.update({ where: { id: accepted.id }, data: { status: 'DECLINED', respondedAt: now } });

    return false;
  }

  const live = isLiveOffer(offer as any, now);

  await tx.missionOffer.update({ where: { id: offer.id }, data: { status: live ? 'DECLINED' : 'EXPIRED', respondedAt: now } });

  return live;
}

/**
 * Among these jobs, the ones reserved against a technician: some offer of the job is live and none of the live ones is theirs. The board uses it
 * to leave those jobs out for the other technicians. One query for all the jobs, however many.
 */
export async function reservedJobIds(db: Tx, interventionIds: number[], userId: number, now: Date = new Date()): Promise<Set<number>> {
  if (!interventionIds.length) return new Set();

  const rows: Array<{ interventionId: number; artisanId: number; status: unknown; expiresAt: unknown }> = await db.missionOffer.findMany({
    where: { interventionId: { in: interventionIds }, status: 'PENDING' },
    select: { interventionId: true, artisanId: true, status: true, expiresAt: true },
  });

  const live = rows.filter((row) => isLiveOffer(row as any, now));
  const reserved = new Set<number>();

  for (const id of new Set(live.map((row) => row.interventionId))) {
    const mine = live.some((row) => row.interventionId === id && row.artisanId === userId);

    if (!mine) reserved.add(id);
  }

  return reserved;
}
