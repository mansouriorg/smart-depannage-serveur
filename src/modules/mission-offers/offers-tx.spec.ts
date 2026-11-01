import { FakeTable } from '../../common/testing/fake-tables';
import { declineOffer, liveOffersOf, reservedJobIds, settleOffersOnTake, withdrawOffers } from './offers-tx';

const MINUTE = 60_000;
const NOW = new Date('2026-11-02T10:00:00Z');
const ahead = (minutes: number) => new Date(NOW.getTime() + minutes * MINUTE);

function makeDb() {
  const offers = new FakeTable({ defaults: () => ({ status: 'PENDING', round: 1, rank: 1, withdrawnReason: null, respondedAt: null }) });
  const add = (interventionId: number, artisanId: number, fields: Record<string, unknown> = {}) => offers.insert({ interventionId, artisanId, expiresAt: ahead(10), ...fields });
  const of = (interventionId: number, artisanId: number) => offers.rows.find((row) => row.interventionId === interventionId && row.artisanId === artisanId)!;

  return { db: { missionOffer: offers }, offers, add, of };
}

describe('the live offers of a job (P3-07)', () => {
  it('are the ones waiting for an answer whose time has not run out', async () => {
    const { db, add } = makeDb();

    add(1, 10);
    add(1, 11, { expiresAt: ahead(-1) });
    add(1, 12, { status: 'DECLINED' });
    add(1, 13, { expiresAt: NOW });
    add(2, 14);

    expect(await liveOffersOf(db, 1, NOW)).toEqual([{ id: 1, artisanId: 10 }]);
  });

  it('are none for a job nobody offered', async () => {
    const { db } = makeDb();

    expect(await liveOffersOf(db, 5, NOW)).toEqual([]);
  });
});

describe('a technician takes the job from the offers (P3-07)', () => {
  it('their offer is accepted and every other live offer is withdrawn as taken, and those technicians are returned to be told', async () => {
    const { db, add, of } = makeDb();

    add(1, 10);
    add(1, 11);
    add(1, 12);

    const told = await settleOffersOnTake(db, { interventionId: 1, winnerId: 11, now: NOW });

    expect(told).toEqual([10, 12]);
    expect(of(1, 11)).toMatchObject({ status: 'ACCEPTED' });
    expect(of(1, 11).respondedAt).toEqual(NOW);
    expect([of(1, 10).status, of(1, 10).withdrawnReason, of(1, 12).status, of(1, 12).withdrawnReason]).toEqual(['WITHDRAWN', 'TAKEN', 'WITHDRAWN', 'TAKEN']);
    expect(of(1, 10).respondedAt).toEqual(NOW);
  });

  it('an offer that had run out is expired, not withdrawn, and its technician is not told the job was taken', async () => {
    const { db, add, of } = makeDb();

    add(1, 10, { expiresAt: ahead(-3) });
    add(1, 11);

    const told = await settleOffersOnTake(db, { interventionId: 1, winnerId: 11, now: NOW });

    expect(told).toEqual([]);
    expect([of(1, 10).status, of(1, 10).withdrawnReason]).toEqual(['EXPIRED', null]);
  });

  it('the winner with no offer of their own (the job was open to all) changes nobody else\'s answer but ends the live offers', async () => {
    const { db, add, of } = makeDb();

    add(1, 10, { expiresAt: ahead(-3) });

    expect(await settleOffersOnTake(db, { interventionId: 1, winnerId: 99, now: NOW })).toEqual([]);
    expect(of(1, 10).status).toBe('EXPIRED');
  });

  it('answered offers and the offers of other jobs are left as they are', async () => {
    const { db, add, of } = makeDb();

    add(1, 10, { status: 'DECLINED', respondedAt: ahead(-4) });
    add(2, 10);
    add(1, 11);

    await settleOffersOnTake(db, { interventionId: 1, winnerId: 11, now: NOW });

    expect(of(1, 10).status).toBe('DECLINED');
    expect(of(1, 10).respondedAt).toEqual(ahead(-4));
    expect(of(2, 10).status).toBe('PENDING');
  });
});

describe('the back office ends the offers of a job (P3-07)', () => {
  it('giving it to a technician accepts theirs and withdraws the others as assigned', async () => {
    const { db, add, of } = makeDb();

    add(1, 10);
    add(1, 11);

    const told = await withdrawOffers(db, { interventionId: 1, reason: 'ASSIGNED', now: NOW, winnerId: 10 });

    expect(told).toEqual([11]);
    expect(of(1, 10).status).toBe('ACCEPTED');
    expect([of(1, 11).status, of(1, 11).withdrawnReason]).toEqual(['WITHDRAWN', 'ASSIGNED']);
  });

  it('calling the round off withdraws everyone as staff, and nobody is accepted', async () => {
    const { db, add, of } = makeDb();

    add(1, 10);
    add(1, 11);

    expect(await withdrawOffers(db, { interventionId: 1, reason: 'STAFF', now: NOW })).toEqual([10, 11]);
    expect(of(1, 10).withdrawnReason).toBe('STAFF');
    expect(db.missionOffer.rows.filter((row) => row.status === 'ACCEPTED')).toHaveLength(0);
  });

  it('a cancelled job withdraws them as cancelled', async () => {
    const { db, add, of } = makeDb();

    add(1, 10);

    await withdrawOffers(db, { interventionId: 1, reason: 'CANCELLED', now: NOW, winnerId: null });

    expect(of(1, 10).withdrawnReason).toBe('CANCELLED');
  });

  it('a job with no offers has nothing to end', async () => {
    const { db } = makeDb();

    expect(await withdrawOffers(db, { interventionId: 7, reason: 'STAFF', now: NOW })).toEqual([]);
  });
});

describe('a technician turns an offer down (P3-07)', () => {
  it('a live offer is declined, and the answer says it was live', async () => {
    const { db, add, of } = makeDb();

    add(1, 10);

    expect(await declineOffer(db, { interventionId: 1, artisanId: 10, now: NOW })).toBe(true);
    expect(of(1, 10).status).toBe('DECLINED');
    expect(of(1, 10).respondedAt).toEqual(NOW);
  });

  it('an offer that had run out is expired, not declined', async () => {
    const { db, add, of } = makeDb();

    add(1, 10, { expiresAt: ahead(-1) });

    expect(await declineOffer(db, { interventionId: 1, artisanId: 10, now: NOW })).toBe(false);
    expect(of(1, 10).status).toBe('EXPIRED');
  });

  it('no offer, or an answered one, changes nothing', async () => {
    const { db, add, of } = makeDb();

    add(1, 11, { status: 'WITHDRAWN', withdrawnReason: 'TAKEN' });

    expect(await declineOffer(db, { interventionId: 1, artisanId: 10, now: NOW })).toBe(false);
    expect(await declineOffer(db, { interventionId: 1, artisanId: 11, now: NOW })).toBe(false);
    expect(of(1, 11).status).toBe('WITHDRAWN');
  });

  it('a technician who gives back a job they had accepted from an offer has declined it', async () => {
    const { db, add, of } = makeDb();

    add(1, 10, { status: 'ACCEPTED', respondedAt: ahead(-5) });
    add(1, 11, { status: 'ACCEPTED' }); // not theirs

    expect(await declineOffer(db, { interventionId: 1, artisanId: 10, now: NOW })).toBe(false);
    expect(of(1, 10).status).toBe('DECLINED');
    expect(of(1, 10).respondedAt).toEqual(NOW);
    expect(of(1, 11).status).toBe('ACCEPTED');
  });

  it('only the technician\'s own offer changes', async () => {
    const { db, add, of } = makeDb();

    add(1, 10);
    add(1, 11);

    await declineOffer(db, { interventionId: 1, artisanId: 10, now: NOW });

    expect(of(1, 11).status).toBe('PENDING');
  });
});

describe('the offers agree with who holds the job (P3-07)', () => {
  it('the back office gives the job to a technician whose offer said it was taken: it says accepted now, and the one who had accepted is withdrawn as assigned', async () => {
    const { db, add, of } = makeDb();

    add(1, 10, { status: 'ACCEPTED', respondedAt: ahead(-2) }); // took it
    add(1, 11, { status: 'WITHDRAWN', withdrawnReason: 'TAKEN', respondedAt: ahead(-2) });
    add(1, 12, { status: 'WITHDRAWN', withdrawnReason: 'TAKEN', respondedAt: ahead(-2) });

    await withdrawOffers(db, { interventionId: 1, reason: 'ASSIGNED', now: NOW, winnerId: 11 });

    expect([of(1, 11).status, of(1, 11).withdrawnReason]).toEqual(['ACCEPTED', null]);
    expect(of(1, 11).respondedAt).toEqual(NOW);
    expect([of(1, 10).status, of(1, 10).withdrawnReason]).toEqual(['WITHDRAWN', 'ASSIGNED']);
    // somebody who is not the holder keeps the account of what happened to them
    expect([of(1, 12).status, of(1, 12).withdrawnReason]).toEqual(['WITHDRAWN', 'TAKEN']);
  });

  it('a technician takes the job from the board after the one who had it gave it back: their old offer says accepted, and nobody else\'s does', async () => {
    const { db, add, of } = makeDb();

    add(1, 10, { status: 'DECLINED' }); // took it, then gave it back
    add(1, 11, { status: 'WITHDRAWN', withdrawnReason: 'TAKEN' });
    add(1, 12, { status: 'EXPIRED' });

    await settleOffersOnTake(db, { interventionId: 1, winnerId: 11, now: NOW });

    expect(of(1, 11).status).toBe('ACCEPTED');
    expect(of(1, 10).status).toBe('DECLINED');
    expect(of(1, 12).status).toBe('EXPIRED');
  });

  it('a technician whose offer ran out and who takes the job from the board holds it: the offer says accepted', async () => {
    const { db, add, of } = makeDb();

    add(1, 11, { status: 'EXPIRED' });

    await settleOffersOnTake(db, { interventionId: 1, winnerId: 11, now: NOW });

    expect(of(1, 11).status).toBe('ACCEPTED');
  });

  it('the back office gives the job to a technician who had declined the offer: it says accepted now, they hold the job', async () => {
    const { db, add, of } = makeDb();

    add(1, 10, { status: 'DECLINED', respondedAt: ahead(-2) });

    await withdrawOffers(db, { interventionId: 1, reason: 'ASSIGNED', now: NOW, winnerId: 10 });

    expect(of(1, 10).status).toBe('ACCEPTED');
  });

  it('a call-off or a cancellation (nobody holds the job) leaves the accepted and the withdrawn as they are', async () => {
    const { db, add, of } = makeDb();

    add(1, 10, { status: 'WITHDRAWN', withdrawnReason: 'TAKEN' });
    add(1, 11);

    await withdrawOffers(db, { interventionId: 1, reason: 'CANCELLED', now: NOW });

    expect(of(1, 10).status).toBe('WITHDRAWN');
    expect([of(1, 11).status, of(1, 11).withdrawnReason]).toEqual(['WITHDRAWN', 'CANCELLED']);
  });
});

describe('the jobs reserved against a technician (P3-07)', () => {
  it('are the jobs with a live offer none of which is theirs', async () => {
    const { db, add } = makeDb();

    add(1, 10); // offered to me
    add(1, 11);
    add(2, 11); // offered to somebody else only
    add(3, 11, { expiresAt: ahead(-1) }); // run out
    add(4, 11, { status: 'DECLINED' }); // answered

    expect([...(await reservedJobIds(db, [1, 2, 3, 4, 5], 10, NOW))]).toEqual([2]);
  });

  it('asks the database once, however many jobs', async () => {
    const { db, add } = makeDb();
    let asked = 0;
    const read = db.missionOffer.findMany;

    db.missionOffer.findMany = async (args: any) => {
      asked += 1;

      return read(args);
    };

    add(1, 11);
    await reservedJobIds(db, [1, 2, 3, 4, 5, 6], 10, NOW);

    expect(asked).toBe(1);
  });

  it('asks nothing when there is no job', async () => {
    const { db } = makeDb();
    let asked = 0;

    db.missionOffer.findMany = async () => {
      asked += 1;

      return [];
    };

    expect((await reservedJobIds(db, [], 10, NOW)).size).toBe(0);
    expect(asked).toBe(0);
  });
});
