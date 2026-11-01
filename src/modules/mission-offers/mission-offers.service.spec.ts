import { atInstantAsync } from '../../common/testing/clock';
import { FakeTable, withTransactions } from '../../common/testing/fake-tables';
import { leakedTo, poisonedJob } from '../../common/testing/poison';
import {
  DEFAULT_OFFER_COUNT,
  DEFAULT_OFFER_MINUTES,
  MAX_OFFERS_LISTED,
  MAX_OFFER_COUNT,
  MAX_OFFER_MINUTES,
  MIN_OFFER_COUNT,
  MIN_OFFER_MINUTES,
} from '../../common/offers/offer-rules';
import { MissionOffersService } from './mission-offers.service';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = new Date('2026-11-02T10:00:00Z');
const at = <T>(work: () => Promise<T>) => atInstantAsync(NOW, work);
const ahead = (minutes: number) => new Date(NOW.getTime() + minutes * MINUTE);

const STAFF = { id: 99, role: 'DISPATCHER' as any };

type Options = {
  /** Called each time the lock of a job is taken: somebody else's change that lands just before the checks. */
  onLock?: (world: World) => void;
  notifyThrows?: boolean;
  liveThrows?: boolean;
  /** The nth offer written (1 = the first) fails, as a database error would. */
  createFailsAt?: number;
  matches?: any[];
};

function makeWorld(options: Options = {}) {
  const users = new FakeTable({ defaults: () => ({ role: 'ARTISAN', isActive: true, deletedAt: null, latitude: null, longitude: null }) });
  const profiles = new FakeTable({ unique: ['userId'], defaults: () => ({ verificationStatus: 'APPROVED' }) });
  const interventions = new FakeTable({ defaults: () => ({ status: 'CREATED', artisanId: null, serviceType: 'PLOMBIER', clientId: 1 }) });
  const appointments = new FakeTable({ unique: ['interventionId'] });
  const offers = new FakeTable({
    defaults: () => ({ status: 'PENDING', round: 1, rank: 1, score: null, withdrawnReason: null, respondedAt: null, offeredAt: NOW, offeredById: null }),
  });

  // `include: { artisan }` on a list: the fake table does not do it on a list.
  const listed = offers.findMany;

  offers.findMany = async (args: any) => {
    const rows = await listed(args);

    return args?.include?.artisan ? rows.map((row: any) => ({ ...row, artisan: users.rows.find((user) => user.id === row.artisanId) })) : rows;
  };

  const logs: string[] = [];
  const locks: number[][] = [];
  const matchCalls: any[] = [];
  const pushes: any[] = [];
  const roundEnds: any[] = [];
  const live: Array<[number, any]> = [];
  const seenOffersAtFirstPush: number[] = [];

  let written = 0;
  const create = offers.create;

  offers.create = async (args: any) => {
    written += 1;

    if (options.createFailsAt === written) throw new Error('database down');

    return create(args);
  };

  const prisma: any = withTransactions(
    {
      user: users,
      artisanProfile: profiles,
      intervention: interventions,
      appointment: appointments,
      missionOffer: offers,
      $executeRaw: async (_strings: TemplateStringsArray, ...values: number[]) => {
        locks.push(values);
        options.onLock?.(world);

        return 1;
      },
    },
    [users, profiles, interventions, appointments, offers],
  );

  const matching: any = {
    findMatchingArtisansForIntervention: async (userId: number, role: string, interventionId: number, query: any) => {
      matchCalls.push({ userId, role, interventionId, query });

      return { matches: options.matches ?? [] };
    },
  };

  const notifications: any = {
    notifyMissionOffered: async (payload: any) => {
      if (seenOffersAtFirstPush.length === 0) seenOffersAtFirstPush.push(offers.rows.length);
      if (options.notifyThrows) throw new Error('push provider down');
      pushes.push(payload);
    },
    notifyOfferRoundEnded: async (payload: any) => {
      roundEnds.push(payload);
    },
  };

  const realtime: any = {
    emitOfferUpdate: (userId: number, payload: any) => {
      if (options.liveThrows) throw new Error('socket down');
      live.push([userId, payload]);
    },
  };

  const service = new MissionOffersService(prisma, matching, notifications, realtime);

  (service as any).logger = { error: (message: string) => logs.push(message) };

  const addArtisan = (fields: Record<string, unknown> = {}, profile: Record<string, unknown> = {}) => {
    const user = users.insert({ email: `artisan${users.rows.length}@mail.tn`, name: `Artisan ${users.rows.length + 1}`, ...fields });

    profiles.insert({ userId: user.id, ...profile });

    return user.id as number;
  };

  const addJob = (fields: Record<string, unknown> = {}) => interventions.insert({ address: 'Rue de Marseille, Tunis', ...fields }).id as number;
  const addOffer = (interventionId: number, artisanId: number, fields: Record<string, unknown> = {}) =>
    offers.insert({ interventionId, artisanId, expiresAt: ahead(10), ...fields });

  const world = {
    service, users, profiles, interventions, appointments, offers,
    logs, locks, matchCalls, pushes, roundEnds, live, seenOffersAtFirstPush,
    addArtisan, addJob, addOffer,
    job: (id: number) => interventions.rows.find((row) => row.id === id)!,
    offersOf: (id: number) => offers.rows.filter((row) => row.interventionId === id),
    offerOf: (interventionId: number, artisanId: number) => offers.rows.find((row) => row.interventionId === interventionId && row.artisanId === artisanId)!,
  };

  return world;
}

type World = ReturnType<typeof makeWorld>;

/** `n` artisans and the matches the matching would give for them, best first. */
function withMatches(n: number, options: Options = {}) {
  const matches: any[] = [];
  const w = makeWorld({ ...options, matches });

  for (let index = 0; index < n; index += 1) {
    const id = w.addArtisan();

    matches.push({ artisanId: id, name: `Artisan ${id}`, score: 95.6 - index, serviceFit: true });
  }

  return { w, matches, ids: matches.map((match) => match.artisanId as number) };
}

async function failure(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('expected a refusal and got an answer');
}

describe('offering a job to the best artisans (P3-07)', () => {
  describe('what a round is', () => {
    it('asks the five best matches for ten minutes by default: ranked, scored, stamped with who offered, and each pushed', async () => {
      const { w, ids } = withMatches(8);
      const id = w.addJob();
      const answer = await at(() => w.service.send(STAFF, id, {}));

      expect(w.offersOf(id).map((row) => row.artisanId)).toEqual(ids.slice(0, DEFAULT_OFFER_COUNT));
      expect(DEFAULT_OFFER_COUNT).toBe(5);
      expect(DEFAULT_OFFER_MINUTES).toBe(10);

      for (const [index, row] of w.offersOf(id).entries()) {
        expect(row).toMatchObject({ round: 1, rank: index + 1, status: 'PENDING', offeredById: 99, score: Math.round(95.6 - index) });
        expect(row.expiresAt.getTime()).toBe(ahead(10).getTime());
        expect(row.offeredAt.getTime()).toBe(NOW.getTime());
      }

      expect(w.pushes.map((push) => push.artisanId)).toEqual(ids.slice(0, 5));
      expect(w.pushes.every((push) => push.interventionId === id && push.actorId === 99 && push.expiresAt.getTime() === ahead(10).getTime())).toBe(true);
      expect(w.pushes.map((push) => push.offerId)).toEqual(w.offersOf(id).map((row) => row.id));

      expect(answer).toMatchObject({ interventionId: id, round: 1, asked: 5, offered: 5 });
      expect(answer.expiresAt.getTime()).toBe(ahead(10).getTime());
      expect(answer.offers.map((offer: any) => [offer.artisanId, offer.rank, offer.name])).toEqual(ids.slice(0, 5).map((artisanId, index) => [artisanId, index + 1, `Artisan ${artisanId}`]));
    });

    it('takes the count and the minutes the back office sends, as numbers or as digits', async () => {
      const { w, ids } = withMatches(8);
      const id = w.addJob();

      await at(() => w.service.send(STAFF, id, { count: 2, minutes: '3' }));

      expect(w.offersOf(id).map((row) => row.artisanId)).toEqual(ids.slice(0, 2));
      expect(w.offersOf(id)[0].expiresAt.getTime()).toBe(ahead(3).getTime());
    });

    it('asks the matching for the artisans who are free, as the person who offers', async () => {
      const { w } = withMatches(2);
      const id = w.addJob();

      await at(() => w.service.send(STAFF, id, {}));

      expect(w.matchCalls).toHaveLength(1);
      expect(w.matchCalls[0]).toMatchObject({ userId: 99, role: 'DISPATCHER', interventionId: id });
      expect(w.matchCalls[0].query.onlyAvailable).toBe(true);
    });

    it('offers to fewer than asked when fewer match, and says how many', async () => {
      const { w } = withMatches(2);
      const id = w.addJob();
      const answer = await at(() => w.service.send(STAFF, id, { count: 5 }));

      expect([answer.asked, answer.offered]).toEqual([5, 2]);
    });

    it('leaves out a match whose trade does not fit', async () => {
      const { w, matches, ids } = withMatches(3);
      const id = w.addJob();

      matches[0].serviceFit = false;

      await at(() => w.service.send(STAFF, id, {}));

      expect(w.offersOf(id).map((row) => row.artisanId)).toEqual(ids.slice(1));
    });

    it('the push goes out after the offers are written, one by one', async () => {
      const { w } = withMatches(3);
      const id = w.addJob();

      await at(() => w.service.send(STAFF, id, {}));

      expect(w.seenOffersAtFirstPush).toEqual([3]);
    });
  });

  describe('what is refused', () => {
    it('a count or a number of minutes out of range or not a whole number is a 400 that says which, and nothing is written', async () => {
      const { w } = withMatches(5);
      const id = w.addJob();

      for (const count of [0, MAX_OFFER_COUNT + 1, -1, 1.5, 'five', true, {}]) {
        const error = await failure(w.service.send(STAFF, id, { count }));

        expect([JSON.stringify(count), error.getStatus(), error.message]).toEqual([JSON.stringify(count), 400, 'Le nombre d’artisans doit être compris entre 1 et 10.']);
      }

      for (const minutes of [0, MAX_OFFER_MINUTES + 1, -5, 2.5, 'ten', false]) {
        const error = await failure(w.service.send(STAFF, id, { minutes }));

        expect([JSON.stringify(minutes), error.getStatus(), error.message]).toEqual([JSON.stringify(minutes), 400, 'La durée de l’offre doit être comprise entre 1 et 120 minutes.']);
      }

      expect(w.offers.rows).toHaveLength(0);
      expect(w.matchCalls).toHaveLength(0);
    });

    it('the bounds the sentences name are the bounds the rules use', () => {
      expect([MIN_OFFER_COUNT, MAX_OFFER_COUNT, MIN_OFFER_MINUTES, MAX_OFFER_MINUTES]).toEqual([1, 10, 1, 120]);
    });

    it('the edges are accepted', async () => {
      for (const [count, minutes] of [[MIN_OFFER_COUNT, MIN_OFFER_MINUTES], [MAX_OFFER_COUNT, MAX_OFFER_MINUTES]]) {
        const { w } = withMatches(12);
        const id = w.addJob();
        const answer = await at(() => w.service.send(STAFF, id, { count, minutes }));

        expect(answer.offered).toBe(count);
        expect(w.offersOf(id)[0].expiresAt.getTime()).toBe(ahead(minutes).getTime());
      }
    });

    it('a job that does not exist, or a number no database holds, is a 404', async () => {
      const { w } = withMatches(2);

      for (const id of [404, 0, -1, 1.5, 2_147_483_648, Number.NaN]) {
        expect([id, (await failure(w.service.send(STAFF, id, {}))).getStatus()]).toEqual([id, 404]);
      }

      expect(w.locks).toHaveLength(0);
    });

    it('a job that is not waiting for an artisan is a 409, and nobody is asked', async () => {
      for (const status of ['ASSIGNED', 'ARTISAN_ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']) {
        const { w } = withMatches(3);
        const id = w.addJob({ status });
        const error = await failure(w.service.send(STAFF, id, {}));

        expect([status, error.getStatus(), error.message]).toEqual([status, 409, 'Cette mission n’est pas ouverte: elle ne peut pas être proposée.']);
        expect(w.offers.rows).toHaveLength(0);
        expect(w.pushes).toHaveLength(0);
      }
    });

    it('the statuses in which a job waits are offered', async () => {
      for (const status of ['CREATED', 'WAITING_ADMIN_REVIEW', 'QUOTE_ACCEPTED']) {
        const { w } = withMatches(1);
        const id = w.addJob({ status });

        expect([status, (await at(() => w.service.send(STAFF, id, {}))).offered]).toEqual([status, 1]);
      }
    });

    it('a job with a visit still to come is a 409 that says to give it directly; a visit that is over or cancelled does not stop it', async () => {
      const { w } = withMatches(2);
      const id = w.addJob();

      w.appointments.insert({ interventionId: id, status: 'SCHEDULED', startsAt: ahead(60), endsAt: ahead(120) });

      const error = await at(() => failure(w.service.send(STAFF, id, {})));

      expect([error.getStatus(), error.message]).toEqual([409, 'Un rendez-vous est déjà fixé pour cette mission: confiez-la directement à un artisan.']);

      w.appointments.rows[0].status = 'CANCELLED';
      expect((await at(() => w.service.send(STAFF, id, {}))).offered).toBe(2);

      const { w: other } = withMatches(2);
      const done = other.addJob();

      other.appointments.insert({ interventionId: done, status: 'SCHEDULED', startsAt: ahead(-180), endsAt: ahead(-120) });
      expect((await at(() => other.service.send(STAFF, done, {}))).offered).toBe(2);
    });

    it('nobody to ask is a 400, and so is a list of matches that were all asked already', async () => {
      const { w: empty } = withMatches(0);
      const none = empty.addJob();

      expect((await failure(empty.service.send(STAFF, none, {}))).getStatus()).toBe(400);

      const { w, ids } = withMatches(2);
      const id = w.addJob();

      for (const artisanId of ids) w.addOffer(id, artisanId, { status: 'DECLINED', expiresAt: ahead(-5) });

      const error = await at(() => failure(w.service.send(STAFF, id, {})));

      expect([error.getStatus(), error.message]).toEqual([400, 'Aucun artisan disponible ne correspond à cette mission, ou tous ont déjà reçu une offre.']);
      expect(w.offers.rows).toHaveLength(2);
    });

    it('a round already running is a 409: the offers of the first are not doubled', async () => {
      const { w, ids } = withMatches(6);
      const id = w.addJob();

      await at(() => w.service.send(STAFF, id, { count: 3 }));

      const error = await at(() => failure(w.service.send(STAFF, id, { count: 3 })));

      expect([error.getStatus(), error.message]).toEqual([409, 'Des offres sont déjà en cours pour cette mission. Attendez leur fin ou retirez-les.']);
      expect(w.offersOf(id).map((row) => row.artisanId)).toEqual(ids.slice(0, 3));
      expect(w.pushes).toHaveLength(3);
    });

    it('the job is taken between the first look and the lock: the checks are made again under the lock, and nothing is written', async () => {
      const { w } = withMatches(3, {
        onLock: (world) => {
          world.interventions.rows[0].status = 'ASSIGNED';
          world.interventions.rows[0].artisanId = 7;
        },
      });
      const id = w.addJob();
      const error = await at(() => failure(w.service.send(STAFF, id, {})));

      expect(error.getStatus()).toBe(409);
      expect(w.locks.map((lock) => lock[1])).toEqual([id]);
      expect(w.offers.rows).toHaveLength(0);
      expect(w.pushes).toHaveLength(0);
    });

    it('a round that went to the database half-way leaves nothing and tells nobody', async () => {
      const { w } = withMatches(4, { createFailsAt: 3 });
      const id = w.addJob();

      await at(() => failure(w.service.send(STAFF, id, {})));

      expect(w.offers.rows).toHaveLength(0);
      expect(w.pushes).toHaveLength(0);
    });
  });

  describe('a second round', () => {
    it('after the first ran out, the artisans already asked are left out and the round number goes up', async () => {
      const { w, ids } = withMatches(8);
      const id = w.addJob();

      await at(() => w.service.send(STAFF, id, { count: 3, minutes: 5 }));

      // six minutes later nobody answered and the sweep has not run yet: the first round is over, unwritten
      const later = new Date(NOW.getTime() + 6 * MINUTE);
      const second = await atInstantAsync(later, () => w.service.send(STAFF, id, { count: 3 }));

      expect(second.round).toBe(2);
      expect(second.offers.map((offer: any) => offer.artisanId)).toEqual(ids.slice(3, 6));
      expect(w.offersOf(id).filter((row) => row.round === 1).map((row) => row.status)).toEqual(['EXPIRED', 'EXPIRED', 'EXPIRED']);
      expect(w.offersOf(id).filter((row) => row.round === 2).map((row) => row.status)).toEqual(['PENDING', 'PENDING', 'PENDING']);
    });

    it('a technician cannot be asked twice for the same job: one row per job and technician', async () => {
      const { w, ids } = withMatches(2);
      const id = w.addJob();

      await at(() => w.service.send(STAFF, id, {}));
      await atInstantAsync(ahead(11), () => failure(w.service.send(STAFF, id, {})));

      expect(w.offersOf(id)).toHaveLength(ids.length);
    });
  });

  describe('a push that fails', () => {
    it('does not undo the offers or turn the answer into an error: the offers stand, and the failure is logged without the details', async () => {
      const { w } = withMatches(3, { notifyThrows: true });
      const id = w.addJob();
      const answer = await at(() => w.service.send(STAFF, id, {}));

      expect(answer.offered).toBe(3);
      expect(w.offersOf(id)).toHaveLength(3);
      expect(w.logs).toHaveLength(3);
      expect(w.logs.join(' ')).not.toMatch(/push provider down|@/);
    });
  });
});

describe('what the back office reads and calls off (P3-07)', () => {
  it('lists the offers of a job by round and rank, with the artisan\'s name, and reads each against the job and the clock', async () => {
    const w = makeWorld();
    const [a, b, c, d] = [w.addArtisan(), w.addArtisan(), w.addArtisan(), w.addArtisan()];
    const id = w.addJob();

    w.addOffer(id, a, { round: 1, rank: 2, score: 80, status: 'DECLINED', respondedAt: ahead(-3), expiresAt: ahead(-1) });
    w.addOffer(id, b, { round: 1, rank: 1, score: 90, status: 'PENDING', expiresAt: ahead(-1) });
    w.addOffer(id, c, { round: 2, rank: 1, score: 70, status: 'PENDING', expiresAt: ahead(4) });
    w.addOffer(id, d, { round: 2, rank: 2, score: 60, status: 'WITHDRAWN', withdrawnReason: 'STAFF' });

    const answer = await at(() => w.service.listForJob(id));

    expect(answer.interventionId).toBe(id);
    expect(answer.offers.map((offer: any) => [offer.round, offer.rank, offer.artisanId, offer.state, offer.because])).toEqual([
      [1, 1, b, 'expired', null],
      [1, 2, a, 'declined', null],
      [2, 1, c, 'open', null],
      [2, 2, d, 'withdrawn', 'staff'],
    ]);
    expect(answer.offers[0]).toMatchObject({ name: w.users.rows.find((user) => user.id === b)!.name, score: 90 });
  });

  it('reads an offer still waiting on a job that is not open any more as withdrawn', async () => {
    const w = makeWorld();
    const a = w.addArtisan();
    const id = w.addJob({ status: 'ASSIGNED', artisanId: 55 });

    w.addOffer(id, a);

    const answer = await at(() => w.service.listForJob(id));

    expect([answer.offers[0].state, answer.offers[0].because]).toEqual(['withdrawn', 'closed']);
  });

  it('a job that does not exist is a 404', async () => {
    const w = makeWorld();

    expect((await failure(w.service.listForJob(5))).getStatus()).toBe(404);
    expect((await failure(w.service.listForJob(0))).getStatus()).toBe(404);
  });

  describe('calling the round off', () => {
    it('ends every live offer as withdrawn by the staff and tells each artisan live; an offer that had run out is only expired', async () => {
      const w = makeWorld();
      const [a, b, lapsed, declined] = [w.addArtisan(), w.addArtisan(), w.addArtisan(), w.addArtisan()];
      const id = w.addJob();

      w.addOffer(id, a);
      w.addOffer(id, b);
      w.addOffer(id, lapsed, { expiresAt: ahead(-2) });
      w.addOffer(id, declined, { status: 'DECLINED' });

      const answer = await at(() => w.service.withdrawRound(99, id));

      expect(answer).toEqual({ interventionId: id, withdrawn: 2, by: 99 });
      expect([w.offerOf(id, a).status, w.offerOf(id, a).withdrawnReason]).toEqual(['WITHDRAWN', 'STAFF']);
      expect([w.offerOf(id, b).status, w.offerOf(id, b).withdrawnReason]).toEqual(['WITHDRAWN', 'STAFF']);
      expect(w.offerOf(id, lapsed).status).toBe('EXPIRED');
      expect(w.offerOf(id, declined).status).toBe('DECLINED');
      expect(w.live).toEqual([
        [a, { interventionId: id, status: 'withdrawn', because: 'staff' }],
        [b, { interventionId: id, status: 'withdrawn', because: 'staff' }],
      ]);
    });

    it('after it the job is open to everybody again, and a new round can be made', async () => {
      const { w, ids } = withMatches(6);
      const id = w.addJob();

      await at(() => w.service.send(STAFF, id, { count: 2 }));
      await at(() => w.service.withdrawRound(99, id));

      const second = await at(() => w.service.send(STAFF, id, { count: 2 }));

      expect(second.round).toBe(2);
      expect(second.offers.map((offer: any) => offer.artisanId)).toEqual(ids.slice(2, 4));
    });

    it('a job with no offers is called off for nobody: no error, no event', async () => {
      const w = makeWorld();
      const id = w.addJob();

      expect(await at(() => w.service.withdrawRound(99, id))).toEqual({ interventionId: id, withdrawn: 0, by: 99 });
      expect(w.live).toEqual([]);
    });

    it('takes the lock of the job, and a job that does not exist is a 404', async () => {
      const w = makeWorld();
      const id = w.addJob();

      await at(() => w.service.withdrawRound(99, id));

      expect(w.locks.map((lock) => lock[1])).toEqual([id]);
      expect((await failure(w.service.withdrawRound(99, 404))).getStatus()).toBe(404);
    });

    it('a live event that fails does not stop the others or undo the withdrawal', async () => {
      const w = makeWorld({ liveThrows: true });
      const [a, b] = [w.addArtisan(), w.addArtisan()];
      const id = w.addJob();

      w.addOffer(id, a);
      w.addOffer(id, b);

      await at(() => w.service.withdrawRound(99, id));

      expect(w.offersOf(id).map((row) => row.status)).toEqual(['WITHDRAWN', 'WITHDRAWN']);
      expect(w.logs).toHaveLength(2);
    });
  });
});

describe('the offers of the artisan who is signed in (P3-07)', () => {
  const job = (w: World, fields: Record<string, unknown> = {}) => {
    const { id: _id, ...row } = poisonedJob({ status: 'CREATED', artisanId: null, serviceType: 'PLOMBIER', latitude: 36.8065, longitude: 10.1815, ...fields });

    return w.interventions.insert(row).id as number;
  };

  it('is for approved artisans: no profile is a 404, a profile that is not approved a 403', async () => {
    const w = makeWorld();
    const stranger = w.users.insert({ role: 'ARTISAN' }).id as number;
    const pending = w.addArtisan({}, { verificationStatus: 'PENDING_REVIEW' });

    expect((await failure(w.service.listMine(stranger))).getStatus()).toBe(404);
    expect((await failure(w.service.listMine(pending))).getStatus()).toBe(403);
  });

  it('gives the server\'s clock, and an empty list when nothing was offered', async () => {
    const w = makeWorld();
    const me = w.addArtisan();
    const answer = await at(() => w.service.listMine(me));

    expect(answer.now.getTime()).toBe(NOW.getTime());
    expect(answer.offers).toEqual([]);
  });

  it('lists the artisan\'s own offers only: the offers made to the others for the same job are not in it', async () => {
    const w = makeWorld();
    const [me, other] = [w.addArtisan(), w.addArtisan()];
    const id = job(w);

    w.addOffer(id, me, { rank: 3, score: 71 });
    w.addOffer(id, other, { rank: 1, score: 99 });

    const answer = await at(() => w.service.listMine(me));
    const text = JSON.stringify(answer);

    expect(answer.offers).toHaveLength(1);
    expect(answer.offers[0]).toMatchObject({ interventionId: id, state: 'open', because: null });
    expect(text).not.toMatch(/"rank"|"score"|"round"|offeredById|artisanId|"artisan"/);
    expect(text).not.toContain(w.users.rows.find((user) => user.id === other)!.name);
  });

  it('an open offer carries the job as the board shows it (no way to reach the customer) and how far it is', async () => {
    const w = makeWorld();
    const me = w.addArtisan({ latitude: 36.8065, longitude: 10.1815 });
    const id = job(w, { latitude: 36.8065, longitude: 10.2815 });

    w.addOffer(id, me);

    const answer = await at(() => w.service.listMine(me));
    const shown = answer.offers[0].job as any;

    expect(shown.id).toBe(id);
    expect(shown.distanceKm).toBeGreaterThan(5);
    expect(shown.distanceKm).toBeLessThan(15);
    expect(leakedTo(answer, 'board')).toEqual([]);
  });

  it('with no position for the artisan or for the job, the distance is null', async () => {
    const w = makeWorld();
    const me = w.addArtisan();
    const id = job(w);

    w.addOffer(id, me);

    expect(((await at(() => w.service.listMine(me))).offers[0].job as any).distanceKm).toBe(null);
  });

  it('an offer that ended shows the trade and nothing else of the job: no address, no description, no customer', async () => {
    const w = makeWorld();
    const me = w.addArtisan();
    const taken = job(w, { status: 'ASSIGNED', artisanId: 31 });

    w.addOffer(taken, me, { status: 'WITHDRAWN', withdrawnReason: 'TAKEN', respondedAt: ahead(-2), expiresAt: ahead(5) });

    const answer = await at(() => w.service.listMine(me));

    expect(answer.offers[0]).toMatchObject({ state: 'withdrawn', because: 'taken', job: { id: taken, serviceType: 'PLOMBIER' } });
    expect(Object.keys(answer.offers[0].job as any).sort()).toEqual(['id', 'serviceType']);
    expect(leakedTo(answer, 'board')).toEqual([]);
    expect(JSON.stringify(answer)).not.toMatch(/SECRET|Rue de Marseille/);
  });

  it('reads a waiting offer against the job and the clock, because the sweep runs once a minute', async () => {
    const w = makeWorld();
    const me = w.addArtisan();
    const lapsed = job(w);
    const closed = job(w, { status: 'CANCELLED' });
    const given = job(w, { status: 'ASSIGNED', artisanId: 8 });

    w.addOffer(lapsed, me, { expiresAt: ahead(-1) });
    w.addOffer(closed, me);
    w.addOffer(given, me);

    const answer = await at(() => w.service.listMine(me));
    const byJob = new Map(answer.offers.map((offer: any) => [offer.interventionId, [offer.state, offer.because]]));

    expect(byJob.get(lapsed)).toEqual(['expired', null]);
    expect(byJob.get(closed)).toEqual(['withdrawn', 'closed']);
    expect(byJob.get(given)).toEqual(['withdrawn', 'closed']);
  });

  it('puts the open offers first, the soonest to run out at the top, then the ended ones, the most recent first', async () => {
    const w = makeWorld();
    const me = w.addArtisan();
    const [late, soon, old, recent] = [job(w), job(w), job(w, { status: 'ASSIGNED', artisanId: 3 }), job(w, { status: 'ASSIGNED', artisanId: 3 })];

    w.addOffer(late, me, { expiresAt: ahead(9), offeredAt: ahead(-1) });
    w.addOffer(soon, me, { expiresAt: ahead(2), offeredAt: ahead(-8) });
    w.addOffer(old, me, { status: 'WITHDRAWN', withdrawnReason: 'TAKEN', offeredAt: ahead(-300), expiresAt: ahead(-290) });
    w.addOffer(recent, me, { status: 'WITHDRAWN', withdrawnReason: 'TAKEN', offeredAt: ahead(-20), expiresAt: ahead(-10) });

    const answer = await at(() => w.service.listMine(me));

    expect(answer.offers.map((offer: any) => offer.interventionId)).toEqual([soon, late, recent, old]);
  });

  it('forgets an offer after a day, and lists no more than the limit', async () => {
    const w = makeWorld();
    const me = w.addArtisan();
    const ancient = job(w, { status: 'ASSIGNED', artisanId: 3 });

    w.addOffer(ancient, me, { status: 'EXPIRED', offeredAt: new Date(NOW.getTime() - 25 * HOUR), expiresAt: new Date(NOW.getTime() - 24 * HOUR) });

    for (let index = 0; index < MAX_OFFERS_LISTED + 5; index += 1) {
      w.addOffer(job(w, { status: 'ASSIGNED', artisanId: 3 }), me, { status: 'EXPIRED', offeredAt: ahead(-60 - index), expiresAt: ahead(-50 - index) });
    }

    const answer = await at(() => w.service.listMine(me));

    expect(answer.offers).toHaveLength(MAX_OFFERS_LISTED);
    expect(answer.offers.some((offer: any) => offer.interventionId === ancient)).toBe(false);
  });
});

describe('the sweep of the offers (P3-07)', () => {
  const lapsedWorld = () => {
    const w = makeWorld();
    const [a, b, c] = [w.addArtisan(), w.addArtisan(), w.addArtisan()];
    const id = w.addJob();

    w.addOffer(id, a, { expiresAt: ahead(-1) });
    w.addOffer(id, b, { expiresAt: ahead(-2) });
    w.addOffer(id, c, { expiresAt: ahead(5) });

    return { w, id, a, b, c };
  };

  it('writes the offers whose time ran out as expired, tells each artisan, and leaves a live offer alone', async () => {
    const { w, id, a, b, c } = lapsedWorld();
    const done = await w.service.sweep(NOW);

    expect(done).toEqual({ expired: 2, withdrawn: 0 });
    expect(w.offerOf(id, a)).toMatchObject({ status: 'EXPIRED' });
    expect(w.offerOf(id, a).respondedAt.getTime()).toBe(NOW.getTime());
    expect(w.offerOf(id, b).status).toBe('EXPIRED');
    expect(w.offerOf(id, c).status).toBe('PENDING');
    expect(w.live).toEqual([
      [b, { interventionId: id, status: 'expired', because: null }],
      [a, { interventionId: id, status: 'expired', because: null }],
    ]);
  });

  it('the instant an offer runs out is the end of it', async () => {
    const w = makeWorld();
    const a = w.addArtisan();
    const id = w.addJob();

    w.addOffer(id, a, { expiresAt: NOW });

    expect((await w.service.sweep(NOW)).expired).toBe(1);
  });

  it('tells the back office once, when the last live offer of an open job ran out, and says how many were asked in the last round', async () => {
    const w = makeWorld();
    const [a, b] = [w.addArtisan(), w.addArtisan()];
    const id = w.addJob();

    w.addOffer(id, a, { round: 1, status: 'DECLINED', expiresAt: ahead(-30) });
    w.addOffer(id, b, { round: 2, expiresAt: ahead(-1) });

    await w.service.sweep(NOW);
    await w.service.sweep(new Date(NOW.getTime() + MINUTE));

    expect(w.roundEnds).toEqual([{ interventionId: id, offered: 1 }]);
  });

  it('does not tell the back office while another offer of the job is live, or when the job was taken', async () => {
    const { w } = lapsedWorld();

    await w.service.sweep(NOW);
    expect(w.roundEnds).toEqual([]);

    const t = makeWorld();
    const [x, y] = [t.addArtisan(), t.addArtisan()];
    const taken = t.addJob({ status: 'ASSIGNED', artisanId: x });

    t.addOffer(taken, y, { expiresAt: ahead(-1) });
    await t.service.sweep(NOW);

    expect(t.roundEnds).toEqual([]);
    expect(t.offerOf(taken, y).status).toBe('EXPIRED');
  });

  it('writes a live offer of a job that is no longer open as withdrawn: taken when somebody holds it, cancelled when nobody does', async () => {
    const w = makeWorld();
    const [a, b] = [w.addArtisan(), w.addArtisan()];
    const held = w.addJob({ status: 'ARTISAN_ACCEPTED', artisanId: 42 });
    const cancelled = w.addJob({ status: 'CANCELLED', artisanId: null });
    const open = w.addJob();

    w.addOffer(held, a);
    w.addOffer(cancelled, a);
    w.addOffer(open, b);

    const done = await w.service.sweep(NOW);

    expect(done).toEqual({ expired: 0, withdrawn: 2 });
    expect([w.offerOf(held, a).status, w.offerOf(held, a).withdrawnReason]).toEqual(['WITHDRAWN', 'TAKEN']);
    expect([w.offerOf(cancelled, a).status, w.offerOf(cancelled, a).withdrawnReason]).toEqual(['WITHDRAWN', 'CANCELLED']);
    expect(w.offerOf(open, b).status).toBe('PENDING');
    expect(w.live).toEqual([
      [a, { interventionId: held, status: 'withdrawn', because: 'taken' }],
      [a, { interventionId: cancelled, status: 'withdrawn', because: 'cancelled' }],
    ]);
  });

  it('a job that left the queue without being cancelled or taken (a quote sent) withdraws the offer with no reason, and the app is told "closed"; a cancelled job with a leftover artisan is cancelled', async () => {
    const w = makeWorld();
    const [a, b] = [w.addArtisan(), w.addArtisan()];
    const quoted = w.addJob({ status: 'QUOTE_SENT', artisanId: null });
    const cancelled = w.addJob({ status: 'CANCELLED', artisanId: 42 });

    w.addOffer(quoted, a);
    w.addOffer(cancelled, b);

    expect((await w.service.sweep(NOW)).withdrawn).toBe(2);
    expect([w.offerOf(quoted, a).status, w.offerOf(quoted, a).withdrawnReason]).toEqual(['WITHDRAWN', null]);
    expect([w.offerOf(cancelled, b).status, w.offerOf(cancelled, b).withdrawnReason]).toEqual(['WITHDRAWN', 'CANCELLED']);
    expect(w.live).toEqual([
      [a, { interventionId: quoted, status: 'withdrawn', because: 'closed' }],
      [b, { interventionId: cancelled, status: 'withdrawn', because: 'cancelled' }],
    ]);
  });

  it('a round is not reported to the back office while an offer of it is still to be written (an earlier write failed): the next sweep reports it once', async () => {
    const w = makeWorld();
    const [a, b, c] = [w.addArtisan(), w.addArtisan(), w.addArtisan()];
    const id = w.addJob();

    w.addOffer(id, a, { expiresAt: ahead(-1) });
    w.addOffer(id, b, { expiresAt: ahead(-1) });
    w.addOffer(id, c, { expiresAt: ahead(-1) });

    const write = w.offers.updateMany;
    let calls = 0;

    w.offers.updateMany = async (args: any) => {
      calls += 1;

      if (calls === 2) throw new Error('connection lost');

      return write(args);
    };

    await w.service.sweep(NOW);

    expect(w.roundEnds).toEqual([]);

    w.offers.updateMany = write;
    await w.service.sweep(new Date(NOW.getTime() + MINUTE));

    expect(w.roundEnds).toEqual([{ interventionId: id, offered: 3 }]);
  });

  it('an offered technician who holds the job through a route that did not settle offers has their offer accepted, not withdrawn, and is told nothing', async () => {
    const w = makeWorld();
    const [a, b] = [w.addArtisan(), w.addArtisan()];
    const id = w.addJob({ status: 'ARTISAN_ACCEPTED', artisanId: a });

    w.addOffer(id, a);
    w.addOffer(id, b);

    const done = await w.service.sweep(NOW);

    expect(done.withdrawn).toBe(1);
    expect(w.offerOf(id, a).status).toBe('ACCEPTED');
    expect([w.offerOf(id, b).status, w.offerOf(id, b).withdrawnReason]).toEqual(['WITHDRAWN', 'TAKEN']);
    expect(w.live).toEqual([[b, { interventionId: id, status: 'withdrawn', because: 'taken' }]]);
  });

  it('a write that fails half way still tells the technicians whose offers were already written as expired', async () => {
    const { w, id, a, b } = lapsedWorld();
    const write = w.offers.updateMany;
    let calls = 0;

    w.offers.updateMany = async (args: any) => {
      calls += 1;

      if (calls === 2) throw new Error('connection lost');

      return write(args);
    };

    const done = await w.service.sweep(NOW);

    expect(done).toEqual({ expired: 0, withdrawn: 0 });
    // the first offer was written before the failure: it is no longer waiting, so no later sweep would tell its technician
    expect(w.live).toHaveLength(1);
    expect(w.logs.length).toBeGreaterThan(0);
    expect([a, b]).toContain(w.live[0][0]);
    expect(w.offersOf(id).filter((row) => row.status === 'EXPIRED')).toHaveLength(1);
  });

  it('one job whose end cannot be reported does not keep the others from being reported', async () => {
    const w = makeWorld();
    const [a, b] = [w.addArtisan(), w.addArtisan()];
    const first = w.addJob();
    const second = w.addJob();

    w.addOffer(first, a, { expiresAt: ahead(-1) });
    w.addOffer(second, b, { expiresAt: ahead(-1) });

    const find = w.interventions.findUnique;
    let once = true;

    w.interventions.findUnique = async (args: any) => {
      if (once) {
        once = false;
        throw new Error('connection lost');
      }

      return find(args);
    };

    expect((await w.service.sweep(NOW)).expired).toBe(2);
    expect(w.roundEnds).toHaveLength(1);
    expect(w.logs).toHaveLength(1);
  });

  it('a second sweep finds nothing to do and tells nobody again', async () => {
    const { w } = lapsedWorld();

    await w.service.sweep(NOW);

    const events = w.live.length;
    const again = await w.service.sweep(NOW);

    expect(again).toEqual({ expired: 0, withdrawn: 0 });
    expect(w.live).toHaveLength(events);
  });

  it('an answer given while the sweep reads is not overwritten: an offer accepted in between stays accepted and is not told as expired', async () => {
    const { w, id, a } = lapsedWorld();
    const read = w.offers.findMany;
    let once = true;

    w.offers.findMany = async (args: any) => {
      const rows = await read(args);

      if (once) {
        once = false;
        w.offerOf(id, a).status = 'ACCEPTED';
      }

      return rows;
    };

    const done = await w.service.sweep(NOW);

    expect(done.expired).toBe(1);
    expect(w.offerOf(id, a).status).toBe('ACCEPTED');
    expect(w.live.map(([userId]) => userId)).not.toContain(a);
  });

  it('an answer given while the sweep reads a job that is no longer open is not overwritten: an offer declined in between stays declined and is not told as withdrawn', async () => {
    const w = makeWorld();
    const a = w.addArtisan();
    const held = w.addJob({ status: 'ARTISAN_ACCEPTED', artisanId: 42 });

    w.addOffer(held, a);

    const read = w.offers.findMany;

    w.offers.findMany = async (args: any) => {
      const rows = await read(args);

      // the read of the offers still waiting (the one that has a lower bound on the end): the answer comes in right after it
      if (args?.where?.expiresAt?.gt) w.offerOf(held, a).status = 'DECLINED';

      return rows;
    };

    const done = await w.service.sweep(NOW);

    expect(done).toEqual({ expired: 0, withdrawn: 0 });
    expect(w.offerOf(held, a).status).toBe('DECLINED');
    expect(w.live).toEqual([]);
  });

  it('two sweeps at the same moment do not both work: the second answers with nothing done, and nobody is told twice', async () => {
    const { w } = lapsedWorld();
    const read = w.offers.findMany;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;

    w.offers.findMany = async (args: any) => {
      if (first) {
        first = false;
        await gate;
      }

      return read(args);
    };

    const running = w.service.sweep(NOW);
    const second = await w.service.sweep(NOW);

    expect(second).toEqual({ expired: 0, withdrawn: 0 });

    release();

    expect(await running).toEqual({ expired: 2, withdrawn: 0 });
    expect(w.live).toHaveLength(2);
  });

  it('a live event that fails does not stop the sweep', async () => {
    const w = makeWorld({ liveThrows: true });
    const [a, b] = [w.addArtisan(), w.addArtisan()];
    const id = w.addJob();

    w.addOffer(id, a, { expiresAt: ahead(-1) });
    w.addOffer(id, b, { expiresAt: ahead(-1) });

    expect((await w.service.sweep(NOW)).expired).toBe(2);
    expect(w.offersOf(id).map((row) => row.status)).toEqual(['EXPIRED', 'EXPIRED']);
    expect(w.logs).toHaveLength(2);
  });

  it('a failure of the database is logged and answered with nothing done, and the next sweep runs', async () => {
    const { w } = lapsedWorld();
    const read = w.offers.findMany;

    w.offers.findMany = async () => {
      throw new Error('connection reset');
    };

    expect(await w.service.sweep(NOW)).toEqual({ expired: 0, withdrawn: 0 });
    expect(w.logs).toHaveLength(1);
    expect(w.logs[0]).not.toContain('connection reset');

    w.offers.findMany = read;

    expect((await w.service.sweep(NOW)).expired).toBe(2);
  });

  it('two sweeps at the same moment are one: the second leaves at once', async () => {
    const { w } = lapsedWorld();
    const [first, second] = await Promise.all([w.service.sweep(NOW), w.service.sweep(NOW)]);

    expect(first.expired + second.expired).toBe(2);
    expect(w.live.filter(([, payload]) => payload.status === 'expired')).toHaveLength(2);
  });

  it('the scheduler\'s call takes the clock of the server, never the argument the scheduler passes', async () => {
    const { w, id, a } = lapsedWorld();

    await at(() => (w.service as any).run('not a date'));

    expect(w.offerOf(id, a).status).toBe('EXPIRED');
  });
});
