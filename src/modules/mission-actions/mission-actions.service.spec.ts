import { FakeTable, withTransactions } from '../../common/testing/fake-tables';
import { MissionActionsService, REFUSAL_REASON_LABELS } from './mission-actions.service';

type Options = {
  notifyThrows?: boolean;
  eventsThrow?: boolean;
  liveThrows?: boolean;
  /** Two requests that reach the same job wait for each other, like the database lock makes them. */
  noLockQueue?: boolean;
  leaveThrows?: boolean;
};

function makeWorld(options: Options = {}) {
  const users = new FakeTable({ defaults: () => ({ role: 'ARTISAN', isActive: true, deletedAt: null }) });
  const profiles = new FakeTable({
    unique: ['userId'],
    defaults: () => ({
      verificationStatus: 'APPROVED',
      isAcceptingJobs: true,
      emergencyAvailable: true,
      maxActiveJobs: 3,
      availability: [],
    }),
  });
  const interventions = new FakeTable({
    defaults: () => ({
      status: 'ASSIGNED',
      artisanId: null,
      urgency: 'NORMAL',
      clientId: 1,
      assignedAt: null,
      artisanAcceptedAt: null,
      artisanOnTheWayAt: null,
      artisanArrivedAt: null,
      artisanRejectedAt: null,
    }),
  });
  const appointments = new FakeTable({ unique: ['interventionId'] });
  const reminders = new FakeTable({ defaults: () => ({ status: 'PENDING' }) });
  const requests = new FakeTable({ defaults: () => ({ status: 'PENDING', type: 'RESCHEDULE' }) });
  const rejections = new FakeTable();

  const locks: number[][] = [];
  const prisma: any = withTransactions(
    {
      user: users,
      artisanProfile: profiles,
      intervention: interventions,
      appointment: appointments,
      appointmentReminder: reminders,
      appointmentRequest: requests,
      artisanMissionRejection: rejections,
      $executeRaw: async (_strings: TemplateStringsArray, ...values: number[]) => {
        locks.push(values);
        return 1;
      },
    },
    [users, profiles, interventions, appointments, reminders, requests, rejections],
  );

  if (!options.noLockQueue) {
    // The advisory lock of the job: a second transaction starts when the first one has ended.
    const original = prisma.$transaction;
    let tail: Promise<unknown> = Promise.resolve();

    prisma.$transaction = (work: any) => {
      const run = tail.then(() => original(work));
      tail = run.catch(() => undefined);

      return run;
    };
  }

  const timeline: any[] = [];
  const told: Array<{ what: string; args: any[] }> = [];
  const live: any[] = [];
  /** Who was taken out of the live room of which job, and the order of that against the live events. */
  const left: Array<[number, number]> = [];
  const order: string[] = [];

  const eventsService: any = {
    create: async (data: any) => {
      if (options.eventsThrow) throw new Error('timeline down');
      timeline.push(data);
    },
  };

  const tell = (what: string) => async (...args: any[]) => {
    if (options.notifyThrows) throw new Error('sms provider down');
    told.push({ what, args });
  };

  const notifications: any = {
    notifyArtisanAcceptedMission: tell('accepted'),
    notifyArtisanOnTheWay: tell('on-the-way'),
    notifyArtisanArrived: tell('arrived'),
    notifyArtisanDeclined: tell('declined'),
  };

  const realtime: any = {
    emitStatusChange: async (payload: any) => {
      if (options.liveThrows) throw new Error('socket down');
      live.push(payload);
      order.push('live');
    },
    removeFromJobRoom: (userId: number, interventionId: number) => {
      if (options.leaveThrows) throw new Error('socket server down');
      left.push([userId, interventionId]);
      order.push('leave');
    },
  };

  const client = users.insert({ role: 'CLIENT', email: 'client@mail.tn' }); // id 1

  const addArtisan = (profile: Record<string, unknown> = {}) => {
    const created = users.insert({ email: `artisan${users.rows.length}@mail.tn` });
    profiles.insert({ userId: created.id, ...profile });

    return created.id as number;
  };

  const addJob = (fields: Record<string, unknown> = {}) =>
    interventions.insert({ clientId: client.id, address: 'Rue de Marseille, Tunis', ...fields }).id as number;

  return {
    users, profiles, interventions, appointments, reminders, requests, rejections,
    locks, timeline, told, live, left, order,
    addArtisan, addJob,
    job: (id: number) => interventions.rows.find((row) => row.id === id)!,
    service: new MissionActionsService(prisma, notifications, eventsService, realtime),
  };
}

type World = ReturnType<typeof makeWorld>;

async function failure(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('expected a failure');
}

const accept = (w: World, userId: number, interventionId: number) => w.service.accept({ userId, interventionId });
const onTheWay = (w: World, userId: number, interventionId: number) => w.service.onTheWay({ userId, interventionId });
const arrived = (w: World, userId: number, interventionId: number) => w.service.arrived({ userId, interventionId });
const decline = (w: World, userId: number, interventionId: number, extra: Record<string, unknown> = {}) =>
  w.service.decline({ userId, interventionId, reason: 'TOO_FAR' as any, ...extra });

/** Nothing was told, written to the timeline or sent live. */
function silent(w: World) {
  expect(w.told).toEqual([]);
  expect(w.timeline).toEqual([]);
  expect(w.live).toEqual([]);
}

describe('accepting a mission (P1-06)', () => {
  it('a mission given to the artisan: the status changes once, the client and the back office are told, the timeline and the live event say it', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const id = w.addJob({ status: 'ASSIGNED', artisanId: artisan, assignedAt: new Date(0) });

    const row = await accept(w, artisan, id);

    expect(row.status).toBe('ACCEPTED'); // the spelling the deployed apps read
    expect(w.job(id).status).toBe('ACCEPTED');
    expect(w.job(id).artisanAcceptedAt).toBeInstanceOf(Date);
    expect(w.job(id).assignedAt).toEqual(new Date(0)); // the dispatcher's date stays

    expect(w.told).toEqual([{ what: 'accepted', args: [id, artisan] }]);
    expect(w.timeline).toHaveLength(1);
    expect(w.timeline[0]).toMatchObject({ interventionId: id, type: 'ARTISAN_ACCEPTED', createdById: artisan });
    expect(w.live).toEqual([{ interventionId: id, oldStatus: 'ASSIGNED', newStatus: 'ACCEPTED', actorId: artisan }]);
  });

  it('an open mission is taken: the artisan and the date of the assignment are written', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const id = w.addJob({ status: 'PENDING', artisanId: null });

    await accept(w, artisan, id);

    expect(w.job(id).artisanId).toBe(artisan);
    expect(w.job(id).status).toBe('ACCEPTED');
    expect(w.job(id).assignedAt).toBeInstanceOf(Date);
    expect(w.job(id).artisanAcceptedAt).toBeInstanceOf(Date);
    expect(w.live[0]).toMatchObject({ oldStatus: 'PENDING', newStatus: 'ACCEPTED' });
  });

  it('every open status can be taken, in both spellings', async () => {
    for (const status of ['CREATED', 'PENDING', 'WAITING_ADMIN_REVIEW', 'ADMIN_REVIEW', 'QUOTE_ACCEPTED']) {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const id = w.addJob({ status });

      await accept(w, artisan, id);

      expect(w.job(id).artisanId).toBe(artisan);
    }
  });

  it('pressed twice, or sent again after a lost answer: the mission comes back as it is, nothing is written, nobody is told twice', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const id = w.addJob({ status: 'ASSIGNED', artisanId: artisan });

    await accept(w, artisan, id);

    const stamp = w.job(id).artisanAcceptedAt;
    const again = await accept(w, artisan, id);

    expect(again.status).toBe('ACCEPTED');
    expect(w.job(id).artisanAcceptedAt).toBe(stamp);
    expect(w.told).toHaveLength(1);
    expect(w.timeline).toHaveLength(1);
    expect(w.live).toHaveLength(1);
  });

  it('a retry works with the canonical spelling too (STATUS_STORAGE=canonical)', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const id = w.addJob({ status: 'ARTISAN_ACCEPTED', artisanId: artisan });

    const row = await accept(w, artisan, id);

    expect(row.status).toBe('ARTISAN_ACCEPTED');
    silent(w);
  });

  it('two taps at the same time change the status once (the second waits for the lock, then finds it done)', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const id = w.addJob({ status: 'ASSIGNED', artisanId: artisan });

    const [first, second] = await Promise.all([accept(w, artisan, id), accept(w, artisan, id)]);

    expect(first.status).toBe('ACCEPTED');
    expect(second.status).toBe('ACCEPTED');
    expect(w.told).toHaveLength(1);
    expect(w.timeline).toHaveLength(1);
    expect(w.live).toHaveLength(1);
  });

  it('two artisans taking the same open mission: one gets it, the other is refused, and only the winner is told about it', async () => {
    const w = makeWorld();
    const first = w.addArtisan();
    const second = w.addArtisan();
    const id = w.addJob({ status: 'PENDING' });

    const results = await Promise.allSettled([accept(w, first, id), accept(w, second, id)]);

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(w.job(id).artisanId).toBe(first);
    // The answer of the P0-10 race: a 409 that says the job went to somebody else, not a 403.
    expect((results[1] as PromiseRejectedResult).reason.getStatus()).toBe(409);
    expect((results[1] as PromiseRejectedResult).reason.message).toBe(
      'Cette mission vient d’être attribuée à un autre artisan ou n’est plus disponible.',
    );
    expect(w.told).toHaveLength(1);
  });

  it('a mission taken by somebody between the check and the write: 409 from the compare-and-set, nothing written', async () => {
    const w = makeWorld({ noLockQueue: true });
    const first = w.addArtisan();
    const second = w.addArtisan();
    const id = w.addJob({ status: 'PENDING' });

    // The other artisan's UPDATE lands just before ours.
    const update = w.interventions.update;
    w.interventions.update = async (args: any) => {
      w.interventions.rows.find((row) => row.id === id)!.artisanId = second;
      w.interventions.update = update;

      return update(args);
    };

    const error = await failure(accept(w, first, id));

    expect(error.getStatus()).toBe(409);
    expect(error.message).toBe('Cette mission vient d’être attribuée à un autre artisan ou n’est plus disponible.');
    expect(w.job(id).artisanAcceptedAt).toBe(null); // nothing of ours was written
    expect(w.job(id).status).toBe('PENDING');
    silent(w);
  });

  it('refuses a mission that is not acceptable: closed, cancelled, already under way', async () => {
    for (const status of ['ON_THE_WAY', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'PAID']) {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const id = w.addJob({ status, artisanId: artisan });

      const error = await failure(accept(w, artisan, id));

      expect(error.getStatus()).toBe(400);
      expect(error.message).toBe('Cette mission ne peut pas être acceptée.');
      expect(w.job(id).status).toBe(status);
      silent(w);
    }
  });

  it('a mission that belongs to another artisan: 409, the answer of the one who comes second, nothing written', async () => {
    const w = makeWorld();
    const mine = w.addArtisan();
    const other = w.addArtisan();
    const id = w.addJob({ status: 'ASSIGNED', artisanId: other });

    const error = await failure(accept(w, mine, id));

    expect(error.getStatus()).toBe(409);
    expect(w.job(id).artisanId).toBe(other);
    silent(w);
  });

  it('an artisan who is not approved cannot accept; a user without a profile is not found; a mission that does not exist is not found', async () => {
    const w = makeWorld();
    const pending = w.addArtisan({ verificationStatus: 'PENDING_REVIEW' });
    const approved = w.addArtisan();
    const noProfile = (w.users.insert({ email: 'x@mail.tn' }) as any).id as number;
    const id = w.addJob({ status: 'PENDING' });

    expect((await failure(accept(w, pending, id))).getStatus()).toBe(403);
    expect((await failure(accept(w, noProfile, id))).getStatus()).toBe(404);
    expect((await failure(accept(w, approved, 999))).getStatus()).toBe(404);
    expect(w.job(id).artisanId).toBe(null);
  });

  it('an id the database cannot hold is a 404 before any query, not an error 500 from the lock', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();

    for (const bad of [0, -3, 1.5, 2_147_483_648, Number.NaN]) {
      expect((await failure(accept(w, artisan, bad))).getStatus()).toBe(404);
      expect((await failure(onTheWay(w, artisan, bad))).getStatus()).toBe(404);
      expect((await failure(decline(w, artisan, bad))).getStatus()).toBe(404);
    }

    expect(w.locks).toEqual([]);
  });

  it('takes the lock of the job first, then the artisan\'s calendar, in the order the assignment does', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const id = w.addJob({ status: 'PENDING' });

    await accept(w, artisan, id);

    expect(w.locks).toEqual([
      [71001, id],
      [71002, artisan],
    ]);
  });

  it('a mission already given to the artisan takes the lock of the job only (the dispatcher already checked the artisan)', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const id = w.addJob({ status: 'ASSIGNED', artisanId: artisan });

    await accept(w, artisan, id);

    expect(w.locks).toEqual([[71001, id]]);
  });
});

describe('taking an open mission follows the same availability rule as being given one', () => {
  it('an artisan who does not take missions cannot take one', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan({ isAcceptingJobs: false });
    const id = w.addJob({ status: 'PENDING' });

    const error = await failure(accept(w, artisan, id));

    expect(error.getStatus()).toBe(400);
    expect(error.getResponse().issues).toEqual([
      'Vous n’acceptez pas de missions pour le moment: activez votre disponibilité dans votre profil.',
    ]);
    expect(w.job(id).artisanId).toBe(null);
    silent(w);
  });

  it('an artisan at the maximum of active missions cannot take another; one below it can', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan({ maxActiveJobs: 2 });

    w.addJob({ status: 'ASSIGNED', artisanId: artisan });
    w.addJob({ status: 'IN_PROGRESS', artisanId: artisan });
    w.addJob({ status: 'COMPLETED', artisanId: artisan }); // finished: does not count

    const id = w.addJob({ status: 'PENDING' });
    const error = await failure(accept(w, artisan, id));

    expect(error.getStatus()).toBe(400);
    expect(error.getResponse().issues).toEqual(['Vous avez atteint votre nombre maximum de missions actives.']);

    w.profiles.rows[0].maxActiveJobs = 3;
    await accept(w, artisan, id);

    expect(w.job(id).artisanId).toBe(artisan);
  });

  it('an urgent job needs an artisan who is available for urgent jobs', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan({ emergencyAvailable: false });
    const urgent = w.addJob({ status: 'PENDING', urgency: 'EMERGENCY' });
    const normal = w.addJob({ status: 'PENDING' });

    expect((await failure(accept(w, artisan, urgent))).getResponse().issues).toEqual([
      'Cette mission est une urgence et votre profil n’est pas disponible pour les urgences.',
    ]);

    await accept(w, artisan, normal);
    expect(w.job(normal).artisanId).toBe(artisan);
  });

  it('a mission the dispatcher already gave to the artisan is accepted whatever the profile says (the artisan is not trapped with it)', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan({ isAcceptingJobs: false, maxActiveJobs: 1 });
    w.addJob({ status: 'IN_PROGRESS', artisanId: artisan });
    const id = w.addJob({ status: 'ASSIGNED', artisanId: artisan, urgency: 'EMERGENCY' });

    await accept(w, artisan, id);

    expect(w.job(id).status).toBe('ACCEPTED');
  });

  it('an artisan who refused a mission cannot take it back by themselves', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const id = w.addJob({ status: 'PENDING' });

    await decline(w, artisan, id);
    const error = await failure(accept(w, artisan, id));

    expect(error.getStatus()).toBe(403);
    expect(error.message).toMatch(/refusé cette mission/);
    expect(w.job(id).artisanId).toBe(null);
  });

  it('the refusal of another artisan does not matter', async () => {
    const w = makeWorld();
    const refuser = w.addArtisan();
    const other = w.addArtisan();
    const id = w.addJob({ status: 'PENDING' });

    await decline(w, refuser, id);
    await accept(w, other, id);

    expect(w.job(id).artisanId).toBe(other);
  });
});

describe('on the way and arrived (P1-06)', () => {
  it('on the way: the date is written once, and the client and the back office are told', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const id = w.addJob({ status: 'ACCEPTED', artisanId: artisan });

    const row = await onTheWay(w, artisan, id);

    expect(row.status).toBe('ON_THE_WAY');
    expect(w.job(id).artisanOnTheWayAt).toBeInstanceOf(Date);
    expect(w.told).toEqual([{ what: 'on-the-way', args: [id, artisan] }]);
    expect(w.timeline).toHaveLength(1);
    expect(w.timeline[0]).toMatchObject({ type: 'ARTISAN_ON_THE_WAY', title: 'Artisan en route', createdById: artisan });
    expect(w.live).toEqual([{ interventionId: id, oldStatus: 'ACCEPTED', newStatus: 'ON_THE_WAY', actorId: artisan }]);
  });

  it('arrived: the same, from on the way', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const id = w.addJob({ status: 'ON_THE_WAY', artisanId: artisan });

    const row = await arrived(w, artisan, id);

    expect(row.status).toBe('ARRIVED');
    expect(w.job(id).artisanArrivedAt).toBeInstanceOf(Date);
    expect(w.told).toEqual([{ what: 'arrived', args: [id, artisan] }]);
    expect(w.timeline[0]).toMatchObject({ type: 'ARTISAN_ARRIVED', title: 'Artisan arrivé' });
    expect(w.live[0]).toMatchObject({ oldStatus: 'ON_THE_WAY', newStatus: 'ARRIVED' });
  });

  it('the whole road in order: accept, on the way, arrived: three changes, three times told', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const id = w.addJob({ status: 'ASSIGNED', artisanId: artisan });

    await accept(w, artisan, id);
    await onTheWay(w, artisan, id);
    await arrived(w, artisan, id);

    expect(w.told.map((t) => t.what)).toEqual(['accepted', 'on-the-way', 'arrived']);
    expect(w.live.map((l) => l.newStatus)).toEqual(['ACCEPTED', 'ON_THE_WAY', 'ARRIVED']);
    expect(w.timeline.map((t) => t.type)).toEqual(['ARTISAN_ACCEPTED', 'ARTISAN_ON_THE_WAY', 'ARTISAN_ARRIVED']);
  });

  it('pressed twice: no second date, no second message, no second timeline line', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const id = w.addJob({ status: 'ACCEPTED', artisanId: artisan });

    await onTheWay(w, artisan, id);
    const stamp = w.job(id).artisanOnTheWayAt;
    const again = await onTheWay(w, artisan, id);

    expect(again.status).toBe('ON_THE_WAY');
    expect(w.job(id).artisanOnTheWayAt).toBe(stamp);
    expect(w.told).toHaveLength(1);
    expect(w.timeline).toHaveLength(1);
    expect(w.live).toHaveLength(1);
  });

  it('two taps at the same time: one change', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const id = w.addJob({ status: 'ON_THE_WAY', artisanId: artisan });

    await Promise.all([arrived(w, artisan, id), arrived(w, artisan, id), arrived(w, artisan, id)]);

    expect(w.told).toHaveLength(1);
    expect(w.live).toHaveLength(1);
  });

  it('the canonical spelling is understood (a mission already written ARTISAN_ON_THE_WAY)', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const id = w.addJob({ status: 'ARTISAN_ON_THE_WAY', artisanId: artisan });

    await arrived(w, artisan, id);

    expect(w.job(id).status).toBe('ARRIVED'); // the spelling of the caller until STATUS_STORAGE=canonical
  });

  it('on the way before accepting: 409 that says what to do first', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const id = w.addJob({ status: 'ASSIGNED', artisanId: artisan });

    const error = await failure(onTheWay(w, artisan, id));

    expect(error.getStatus()).toBe(409);
    expect(error.message).toBe('Acceptez d’abord la mission avant de partir.');
    expect(w.job(id).status).toBe('ASSIGNED');
    silent(w);
  });

  it('arrived before being on the way: 409 that says what to do first', async () => {
    for (const status of ['ASSIGNED', 'ACCEPTED']) {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const id = w.addJob({ status, artisanId: artisan });

      const error = await failure(arrived(w, artisan, id));

      expect(error.getStatus()).toBe(409);
      expect(error.message).toBe('Indiquez d’abord que vous êtes en route.');
      expect(w.job(id).status).toBe(status);
      silent(w);
    }
  });

  it('from a status that cannot go there (under way, finished, cancelled): 409, nothing written', async () => {
    for (const status of ['IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'PAID']) {
      for (const step of [onTheWay, arrived]) {
        const w = makeWorld();
        const artisan = w.addArtisan();
        const id = w.addJob({ status, artisanId: artisan });

        const error = await failure(step(w, artisan, id));

        expect(error.getStatus()).toBe(409);
        expect(error.message).toBe('Cette action n’est plus possible dans l’état actuel de la mission.');
        expect(w.job(id).status).toBe(status);
        silent(w);
      }
    }
  });

  it('on the way after arriving is refused (the status never goes back)', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const id = w.addJob({ status: 'ARRIVED', artisanId: artisan });

    expect((await failure(onTheWay(w, artisan, id))).getStatus()).toBe(409);
    expect(w.job(id).status).toBe('ARRIVED');
  });

  it('only the artisan who has the mission: another artisan 403, an open mission 403, a missing one 404', async () => {
    const w = makeWorld();
    const mine = w.addArtisan();
    const other = w.addArtisan();
    const owned = w.addJob({ status: 'ACCEPTED', artisanId: other });
    const open = w.addJob({ status: 'PENDING', artisanId: null });

    for (const step of [onTheWay, arrived]) {
      expect((await failure(step(w, mine, owned))).getStatus()).toBe(403);
      expect((await failure(step(w, mine, open))).getStatus()).toBe(403);
      expect((await failure(step(w, mine, 4040))).getStatus()).toBe(404);
    }

    expect(w.job(owned).status).toBe('ACCEPTED');
    expect(w.job(open).artisanId).toBe(null);
    silent(w);
  });

  it('an artisan who is not approved cannot use the steps', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan({ verificationStatus: 'SUSPENDED' });
    const id = w.addJob({ status: 'ACCEPTED', artisanId: artisan });

    expect((await failure(onTheWay(w, artisan, id))).getStatus()).toBe(403);
    expect(w.job(id).status).toBe('ACCEPTED');
  });

  it('takes the lock of the job', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const id = w.addJob({ status: 'ACCEPTED', artisanId: artisan });

    await onTheWay(w, artisan, id);

    expect(w.locks).toEqual([[71001, id]]);
  });
});

describe('what follows an action never undoes it', () => {
  it('a notification that fails: the action stays, the timeline and the live event are still done', async () => {
    const w = makeWorld({ notifyThrows: true });
    const artisan = w.addArtisan();
    const id = w.addJob({ status: 'ASSIGNED', artisanId: artisan });

    const row = await accept(w, artisan, id);

    expect(row.status).toBe('ACCEPTED');
    expect(w.job(id).status).toBe('ACCEPTED');
    expect(w.timeline).toHaveLength(1);
    expect(w.live).toHaveLength(1);
  });

  it('a timeline that fails: the action stays, the people are still told', async () => {
    const w = makeWorld({ eventsThrow: true });
    const artisan = w.addArtisan();
    const id = w.addJob({ status: 'ACCEPTED', artisanId: artisan });

    await onTheWay(w, artisan, id);

    expect(w.job(id).status).toBe('ON_THE_WAY');
    expect(w.told).toHaveLength(1);
    expect(w.live).toHaveLength(1);
  });

  it('a live event that fails: the action stays', async () => {
    const w = makeWorld({ liveThrows: true });
    const artisan = w.addArtisan();
    const id = w.addJob({ status: 'ON_THE_WAY', artisanId: artisan });

    await arrived(w, artisan, id);

    expect(w.job(id).status).toBe('ARRIVED');
    expect(w.told).toHaveLength(1);
  });

  it('everything failing at once is still a success for the artisan, and a refusal too', async () => {
    const w = makeWorld({ notifyThrows: true, eventsThrow: true, liveThrows: true });
    const artisan = w.addArtisan();
    const id = w.addJob({ status: 'ASSIGNED', artisanId: artisan });

    expect(await decline(w, artisan, id)).toEqual({ message: 'Mission refusée.', returnedToQueue: true });
    expect(w.job(id).artisanId).toBe(null);
  });
});

describe('giving a mission back (P1-06)', () => {
  it('the job goes back to the dispatcher queue, free, with the dates of the artisan\'s steps cleared', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const id = w.addJob({
      status: 'ON_THE_WAY',
      artisanId: artisan,
      assignedAt: new Date(1),
      artisanAcceptedAt: new Date(2),
      artisanOnTheWayAt: new Date(3),
    });

    const answer = await decline(w, artisan, id, { reason: 'NOT_AVAILABLE', note: 'Panne de voiture' });

    expect(answer).toEqual({ message: 'Mission refusée.', returnedToQueue: true });
    expect(w.job(id)).toMatchObject({
      status: 'ADMIN_REVIEW', // the spelling the dashboard reads for the queue
      artisanId: null,
      assignedAt: null,
      artisanAcceptedAt: null,
      artisanOnTheWayAt: null,
      artisanArrivedAt: null,
    });
    expect(w.job(id).artisanRejectedAt).toBeInstanceOf(Date);
    expect(w.job(id).lastStatusChangedAt).toBeInstanceOf(Date);
  });

  it('it can be given back from every status before the work starts', async () => {
    for (const status of ['ASSIGNED', 'ACCEPTED', 'ARTISAN_ACCEPTED', 'ON_THE_WAY', 'ARRIVED']) {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const id = w.addJob({ status, artisanId: artisan });

      await decline(w, artisan, id);

      expect(w.job(id).artisanId).toBe(null);
      expect(w.job(id).status).toBe('ADMIN_REVIEW');
    }
  });

  it('not once the work has started or the job is closed: 409, and nothing is written, not even the refusal', async () => {
    for (const status of ['IN_PROGRESS', 'WAITING_CLIENT_VALIDATION', 'COMPLETED', 'PAID', 'CANCELLED', 'DISPUTED']) {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const id = w.addJob({ status, artisanId: artisan });

      const error = await failure(decline(w, artisan, id));

      expect(error.getStatus()).toBe(409);
      expect(error.message).toMatch(/ne peut plus être rendue/);
      expect(w.job(id).status).toBe(status);
      expect(w.job(id).artisanId).toBe(artisan);
      expect(w.rejections.rows).toEqual([]);
      silent(w);
    }
  });

  it('the refusal is remembered once with its reason and note; pressed twice it does not pile up', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const id = w.addJob({ status: 'ASSIGNED', artisanId: artisan });

    await decline(w, artisan, id, { reason: 'TOO_FAR', note: 'À 80 km' });
    await decline(w, artisan, id, { reason: 'TOO_FAR', note: 'À 80 km' });

    expect(w.rejections.rows).toHaveLength(1);
    expect(w.rejections.rows[0]).toMatchObject({ interventionId: id, reason: 'TOO_FAR', note: 'À 80 km' });
    expect(w.rejections.rows[0].artisanProfileId).toBe(w.profiles.rows[0].id);
  });

  it('pressed twice: the second press tells nobody and sends nothing live', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const id = w.addJob({ status: 'ASSIGNED', artisanId: artisan });

    const first = await decline(w, artisan, id);
    const second = await decline(w, artisan, id);

    expect(first.returnedToQueue).toBe(true);
    expect(second.returnedToQueue).toBe(false);
    expect(w.told).toHaveLength(1);
    expect(w.live).toHaveLength(1);
    expect(w.timeline).toHaveLength(1);
  });

  it('two presses at the same time: one refusal line, one set of messages', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const id = w.addJob({ status: 'ASSIGNED', artisanId: artisan });

    await Promise.all([decline(w, artisan, id), decline(w, artisan, id)]);

    expect(w.rejections.rows).toHaveLength(1);
    expect(w.told).toHaveLength(1);
  });

  it('a note left out is stored as nothing, and the back office reads the reason alone', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const id = w.addJob({ status: 'ASSIGNED', artisanId: artisan });

    await decline(w, artisan, id, { reason: 'OTHER' });

    expect(w.rejections.rows[0].note).toBe(null);
    expect(w.told[0].args[2]).toBe('autre motif');
  });

  it('a note of spaces only is no note', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const id = w.addJob({ status: 'ASSIGNED', artisanId: artisan });

    await decline(w, artisan, id, { reason: 'TOO_FAR', note: '   ' });

    expect(w.told[0].args[2]).toBe('trop loin');
  });

  it('a job handed to somebody else between the check and the write is not taken from them: 409, nothing written', async () => {
    const w = makeWorld({ noLockQueue: true });
    const artisan = w.addArtisan();
    const other = w.addArtisan();
    const id = w.addJob({ status: 'ASSIGNED', artisanId: artisan });

    // A writer that does not take our lock hands the job over just before our UPDATE.
    const update = w.interventions.update;
    w.interventions.update = async (args: any) => {
      w.interventions.rows.find((row) => row.id === id)!.artisanId = other;
      w.interventions.update = update;

      return update(args);
    };

    const error = await failure(decline(w, artisan, id));

    expect(error.getStatus()).toBe(409);
    expect(w.job(id).status).toBe('ASSIGNED');
    expect(w.rejections.rows).toEqual([]);
    silent(w);
  });

  it('the back office is told with the reason; the client is told without it; the timeline (which the client reads) has no reason', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const id = w.addJob({ status: 'ACCEPTED', artisanId: artisan });

    await decline(w, artisan, id, { reason: 'PRICE_TOO_LOW', note: 'Trop peu payé' });

    expect(w.told).toEqual([{ what: 'declined', args: [id, artisan, 'prix trop bas: Trop peu payé'] }]);
    expect(w.timeline).toHaveLength(1);
    expect(w.timeline[0]).toMatchObject({ interventionId: id, type: 'STATUS_CHANGED', title: 'Artisan indisponible' });
    // The client reads the timeline: the line is not signed, so it does not say who gave the job back.
    expect(w.timeline[0].createdById).toBeUndefined();
    expect(JSON.stringify(w.timeline[0])).not.toContain(`${artisan}`);
    expect(JSON.stringify(w.timeline[0])).not.toMatch(/prix|PRICE|payé/i);
    expect(w.timeline[0].type).not.toBe('CANCELLED'); // it is not a cancellation of the job
    expect(w.live).toEqual([{ interventionId: id, oldStatus: 'ACCEPTED', newStatus: 'ADMIN_REVIEW', actorId: artisan }]);
  });

  it('a long note is cut in the notification, whole in the record', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const id = w.addJob({ status: 'ASSIGNED', artisanId: artisan });
    const note = 'x'.repeat(500);

    await decline(w, artisan, id, { reason: 'OTHER', note });

    expect(w.told[0].args[2]).toBe(`autre motif: ${'x'.repeat(200)}…`);
    expect(w.rejections.rows[0].note).toBe(note);
  });

  it('every reason has a label for the back office', () => {
    for (const reason of ['NOT_AVAILABLE', 'TOO_FAR', 'OUT_OF_SPECIALTY', 'PRICE_TOO_LOW', 'OTHER']) {
      expect(typeof (REFUSAL_REASON_LABELS as any)[reason]).toBe('string');
    }
  });

  describe('the visit planned for the artisan', () => {
    const plan = (w: World, id: number, artisan: number | null, fields: Record<string, unknown> = {}) =>
      w.appointments.insert({
        interventionId: id,
        clientId: 1,
        artisanId: artisan,
        status: 'SCHEDULED',
        startsAt: new Date(Date.now() + 5 * 24 * 3600_000),
        endsAt: new Date(Date.now() + 5 * 24 * 3600_000 + 3600_000),
        ...fields,
      });

    it('is put in nobody\'s name; its waiting requests are closed; the reminders not sent yet are dropped, the sent ones stay', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const id = w.addJob({ status: 'ASSIGNED', artisanId: artisan });
      const visit = plan(w, id, artisan);

      w.reminders.insert({ appointmentId: visit.id, recipientId: artisan, minutesBefore: 120, status: 'PENDING' });
      w.reminders.insert({ appointmentId: visit.id, recipientId: 1, minutesBefore: 1440, status: 'PENDING' });
      w.reminders.insert({ appointmentId: visit.id, recipientId: 1, minutesBefore: 2880, status: 'SENT' });
      w.requests.insert({ appointmentId: visit.id });
      w.requests.insert({ appointmentId: visit.id, status: 'APPROVED' });

      await decline(w, artisan, id);

      expect(w.appointments.rows[0].artisanId).toBe(null);
      expect(w.appointments.rows[0].startsAt).toEqual(visit.startsAt); // the time stays for the next artisan
      expect(w.reminders.rows.map((r) => r.status)).toEqual(['SENT']);
      expect(w.requests.rows.map((r) => r.status)).toEqual(['CANCELLED', 'APPROVED']);
      expect(w.requests.rows[0].adminResponse).toBe('Demande classée: l’artisan a rendu la mission.');
    });

    it('a cancellation that was asked for is done, a new time that was asked for is dropped', async () => {
      const cancelling = makeWorld();
      const a1 = cancelling.addArtisan();
      const j1 = cancelling.addJob({ status: 'ASSIGNED', artisanId: a1 });
      plan(cancelling, j1, a1, { status: 'CANCEL_REQUESTED' });
      await decline(cancelling, a1, j1);

      expect(cancelling.appointments.rows[0]).toMatchObject({ status: 'CANCELLED', artisanId: null, cancelReason: 'L’artisan a rendu la mission.' });
      expect(cancelling.appointments.rows[0].cancelledAt).toBeInstanceOf(Date);

      const moving = makeWorld();
      const a2 = moving.addArtisan();
      const j2 = moving.addJob({ status: 'ASSIGNED', artisanId: a2 });
      plan(moving, j2, a2, { status: 'RESCHEDULE_REQUESTED' });
      await decline(moving, a2, j2);

      expect(moving.appointments.rows[0]).toMatchObject({ status: 'SCHEDULED', artisanId: null });
    });

    it('a visit that is not this artisan\'s is left alone', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const other = w.addArtisan();
      const id = w.addJob({ status: 'ASSIGNED', artisanId: artisan });
      const visit = plan(w, id, other);

      w.requests.insert({ appointmentId: visit.id });
      w.reminders.insert({ appointmentId: visit.id, recipientId: other, minutesBefore: 120 });

      await decline(w, artisan, id);

      expect(w.appointments.rows[0].artisanId).toBe(other);
      expect(w.requests.rows[0].status).toBe('PENDING');
      expect(w.reminders.rows).toHaveLength(1);
    });

    it('a job without a visit is given back all the same', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const id = w.addJob({ status: 'ASSIGNED', artisanId: artisan });

      await decline(w, artisan, id);

      expect(w.job(id).artisanId).toBe(null);
      expect(w.appointments.rows).toEqual([]);
    });

    it('everything is one transaction: a failure while freeing the visit leaves the job with the artisan and no refusal written', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const id = w.addJob({ status: 'ASSIGNED', artisanId: artisan });

      plan(w, id, artisan);
      w.appointments.update = async () => {
        throw new Error('database error');
      };

      await failure(decline(w, artisan, id));

      expect(w.job(id).artisanId).toBe(artisan);
      expect(w.job(id).status).toBe('ASSIGNED');
      expect(w.rejections.rows).toEqual([]);
      silent(w);
    });
  });

  describe('a mission nobody has yet', () => {
    it('is only remembered as refused: the status, the timeline, the people and the live event do not move', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const id = w.addJob({ status: 'PENDING', artisanId: null });

      const answer = await decline(w, artisan, id, { reason: 'OUT_OF_SPECIALTY' });

      expect(answer).toEqual({ message: 'Mission refusée.', returnedToQueue: false });
      expect(w.job(id).status).toBe('PENDING');
      expect(w.job(id).artisanRejectedAt).toBeInstanceOf(Date);
      expect(w.rejections.rows).toHaveLength(1);
      silent(w);
    });

    it('a job that is not open any more (cancelled, finished) cannot be refused: 409', async () => {
      for (const status of ['CANCELLED', 'COMPLETED', 'QUOTE_SENT']) {
        const w = makeWorld();
        const artisan = w.addArtisan();
        const id = w.addJob({ status, artisanId: null });

        expect((await failure(decline(w, artisan, id))).getStatus()).toBe(409);
        expect(w.rejections.rows).toEqual([]);
      }
    });

    it('the same artisan refusing two jobs leaves two lines; two artisans refusing one job leave two lines', async () => {
      const w = makeWorld();
      const a = w.addArtisan();
      const b = w.addArtisan();
      const one = w.addJob({ status: 'PENDING' });
      const two = w.addJob({ status: 'PENDING' });

      await decline(w, a, one);
      await decline(w, a, two);
      await decline(w, b, one);

      expect(w.rejections.rows).toHaveLength(3);
    });
  });

  it('a mission of another artisan cannot be given back by someone else: 403', async () => {
    const w = makeWorld();
    const mine = w.addArtisan();
    const other = w.addArtisan();
    const id = w.addJob({ status: 'ASSIGNED', artisanId: other });

    const error = await failure(decline(w, mine, id));

    expect(error.getStatus()).toBe(403);
    expect(w.job(id).artisanId).toBe(other);
    expect(w.rejections.rows).toEqual([]);
    silent(w);
  });

  it('a mission that does not exist: 404; an artisan who is not approved: 403', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const pending = w.addArtisan({ verificationStatus: 'PENDING_REVIEW' });
    const id = w.addJob({ status: 'ASSIGNED', artisanId: pending });

    expect((await failure(decline(w, artisan, 777))).getStatus()).toBe(404);
    expect((await failure(decline(w, pending, id))).getStatus()).toBe(403);
  });

  it('takes the lock of the job before reading it', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const id = w.addJob({ status: 'ASSIGNED', artisanId: artisan });

    await decline(w, artisan, id);

    expect(w.locks).toEqual([[71001, id]]);
  });

  it('after it, the dispatcher can give the job to somebody else, who can take it from there', async () => {
    const w = makeWorld();
    const first = w.addArtisan();
    const second = w.addArtisan();
    const id = w.addJob({ status: 'ASSIGNED', artisanId: first });

    await decline(w, first, id);
    await accept(w, second, id); // the job is open again

    expect(w.job(id)).toMatchObject({ artisanId: second, status: 'ACCEPTED' });
  });
});

// ----------------------------------------------------------
// What the independent review of P1-06 found
// ----------------------------------------------------------

describe('a job that still carries the id of an artisan after the back office took it back', () => {
  // The workflow moves a job to the dispatcher queue and leaves the artisan's id on it.
  const takenBack = (w: World, artisan: number, fields: Record<string, unknown> = {}) =>
    w.addJob({ status: 'ADMIN_REVIEW', artisanId: artisan, assignedAt: new Date(1), artisanAcceptedAt: new Date(2), ...fields });

  it('is an open job for that artisan: accepting it takes the rule of an open job and writes a new date of assignment', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const id = takenBack(w, artisan);

    await accept(w, artisan, id);

    expect(w.job(id)).toMatchObject({ artisanId: artisan, status: 'ACCEPTED' });
    expect(w.job(id).assignedAt).not.toEqual(new Date(1));
    expect(w.locks).toEqual([[71001, id], [71002, artisan]]); // the calendar is locked: it is a claim
    expect(w.told).toHaveLength(1);
  });

  it('the profile is checked: an artisan who does not take missions is refused, not let in by the old id', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan({ isAcceptingJobs: false });
    const id = takenBack(w, artisan);

    expect((await failure(accept(w, artisan, id))).getStatus()).toBe(400);
    expect(w.job(id).status).toBe('ADMIN_REVIEW');
    silent(w);
  });

  it('a refusal already given is respected', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const id = takenBack(w, artisan);

    w.rejections.insert({ artisanProfileId: w.profiles.rows[0].id, interventionId: id, reason: 'TOO_FAR' });

    expect((await failure(accept(w, artisan, id))).getStatus()).toBe(403);
    silent(w);
  });

  it('giving it back clears the old id and the dates although the status does not change, and tells nobody it moved', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const id = takenBack(w, artisan);

    const answer = await decline(w, artisan, id, { reason: 'NOT_AVAILABLE' });

    expect(answer).toEqual({ message: 'Mission refusée.', returnedToQueue: false });
    expect(w.job(id)).toMatchObject({ status: 'ADMIN_REVIEW', artisanId: null, assignedAt: null, artisanAcceptedAt: null });
    expect(w.job(id).artisanRejectedAt).toBeInstanceOf(Date);
    expect(w.rejections.rows).toHaveLength(1);
    // Nothing moved for the client or the back office: no message, no timeline line, no event
    // that says "from the queue to the queue".
    silent(w);
    // The artisan stops hearing about the job.
    expect(w.left).toEqual([[artisan, id]]);
  });

  it('a job that waits for a quote answer keeps its status when the old id is given back: only the id and the dates go', async () => {
    for (const status of ['QUOTE_ACCEPTED', 'CREATED', 'PENDING', 'WAITING_ADMIN_REVIEW']) {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const id = takenBack(w, artisan, { status });

      await decline(w, artisan, id);

      expect(w.job(id).status).toBe(status);
      expect(w.job(id).artisanId).toBe(null);
      expect(w.job(id).assignedAt).toBe(null);
    }
  });

  it('the steps are not theirs: on the way is refused by the status table', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const id = takenBack(w, artisan);

    expect((await failure(onTheWay(w, artisan, id))).getStatus()).toBe(409);
    expect(w.job(id).artisanOnTheWayAt).toBe(null);
    silent(w);
  });

  it('a closed job that carries their id cannot be given back either', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const id = w.addJob({ status: 'COMPLETED', artisanId: artisan });

    const error = await failure(decline(w, artisan, id));

    expect(error.getStatus()).toBe(409);
    expect(error.message).toMatch(/ne peut plus être rendue/);
    expect(w.left).toEqual([]);
  });
});

describe('taking an open mission that has a visit planned', () => {
  const visit = (w: World, id: number, fields: Record<string, unknown> = {}) =>
    w.appointments.insert({
      interventionId: id,
      clientId: 1,
      artisanId: null,
      status: 'SCHEDULED',
      startsAt: new Date(Date.now() + 2 * 24 * 3600_000),
      endsAt: new Date(Date.now() + 2 * 24 * 3600_000 + 3600_000),
      ...fields,
    });

  it('a visit that is still to come goes through the dispatcher: 409 that says so, nothing written, no refusal made', async () => {
    for (const status of ['SCHEDULED', 'CONFIRMED', 'RESCHEDULE_REQUESTED', 'CANCEL_REQUESTED']) {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const id = w.addJob({ status: 'ADMIN_REVIEW' });

      visit(w, id, { status });

      const error = await failure(accept(w, artisan, id));

      expect(error.getStatus()).toBe(409);
      expect(error.message).toBe('Un rendez-vous est déjà fixé pour cette mission: le service client doit vous la confier.');
      expect(w.job(id).artisanId).toBe(null);
      expect(w.rejections.rows).toEqual([]);
      silent(w);
    }
  });

  it('the visit is no obstacle when it has no time, is cancelled or done, or is over', async () => {
    const cases: Array<Record<string, unknown>> = [
      { startsAt: null, endsAt: null, status: 'REQUESTED' }, // the client only said when they would like it
      { status: 'CANCELLED' },
      { status: 'COMPLETED' },
      { startsAt: new Date(Date.now() - 3 * 24 * 3600_000), endsAt: new Date(Date.now() - 3 * 24 * 3600_000 + 3600_000) },
    ];

    for (const fields of cases) {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const id = w.addJob({ status: 'ADMIN_REVIEW' });

      visit(w, id, fields);
      await accept(w, artisan, id);

      expect(w.job(id).artisanId).toBe(artisan);
    }
  });

  it('a visit left in the name of another artisan does not come with the job: nobody\'s name, requests closed, reminders dropped', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const gone = w.addArtisan();
    const id = w.addJob({ status: 'ADMIN_REVIEW' });
    const old = visit(w, id, {
      artisanId: gone,
      status: 'CANCEL_REQUESTED',
      startsAt: new Date(Date.now() - 3 * 24 * 3600_000),
      endsAt: new Date(Date.now() - 3 * 24 * 3600_000 + 3600_000),
    });

    w.requests.insert({ appointmentId: old.id });
    w.reminders.insert({ appointmentId: old.id, recipientId: gone, minutesBefore: 120, status: 'PENDING' });
    w.reminders.insert({ appointmentId: old.id, recipientId: 1, minutesBefore: 1440, status: 'SENT' });

    await accept(w, artisan, id);

    expect(w.job(id).artisanId).toBe(artisan);
    expect(w.appointments.rows[0]).toMatchObject({ artisanId: null, status: 'CANCELLED' });
    expect(w.requests.rows.map((r) => r.status)).toEqual(['CANCELLED']);
    expect(w.reminders.rows.map((r) => r.status)).toEqual(['SENT']);
  });

  it('the visit of the artisan who is given the job is not touched by accepting it', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const id = w.addJob({ status: 'ASSIGNED', artisanId: artisan });

    visit(w, id, { artisanId: artisan, status: 'SCHEDULED' });
    await accept(w, artisan, id);

    expect(w.appointments.rows[0]).toMatchObject({ artisanId: artisan, status: 'SCHEDULED' });
  });
});

describe('what an artisan gets back never holds the notes of the back office', () => {
  const secrets = {
    adminInternalNotes: 'client difficile',
    adminReviewStartedAt: new Date(5),
    trackingToken: 'hash-of-the-link',
    cancelledById: 9,
  };

  const clean = (row: any) => {
    expect(row).toBeTruthy();
    for (const key of Object.keys(secrets)) expect(key in row).toBe(false);
    expect(row.address).toBe('Rue de Marseille, Tunis'); // the rest of the row is there
  };

  it('accepting, on the way, arrived', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const id = w.addJob({ status: 'ASSIGNED', artisanId: artisan, ...secrets });

    clean(await accept(w, artisan, id));
    clean(await onTheWay(w, artisan, id));
    clean(await arrived(w, artisan, id));
  });

  it('accepting again, and taking an open mission', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const given = w.addJob({ status: 'ACCEPTED', artisanId: artisan, ...secrets });
    const open = w.addJob({ status: 'PENDING', ...secrets });

    clean(await accept(w, artisan, given));
    clean(await accept(w, artisan, open));
  });

  it('the notes stay on the job', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const id = w.addJob({ status: 'ASSIGNED', artisanId: artisan, ...secrets });

    await accept(w, artisan, id);

    expect(w.job(id).adminInternalNotes).toBe('client difficile');
  });
});

describe('the artisan who gave the job back stops hearing about it', () => {
  it('they leave the live room of the job, before the live event about the job is sent', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const id = w.addJob({ status: 'ACCEPTED', artisanId: artisan });

    await decline(w, artisan, id);

    expect(w.left).toEqual([[artisan, id]]);
    expect(w.order).toEqual(['leave', 'live']);
  });

  it('only when they really left the job: not for an open job, not for a refused attempt, not for a second press', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const open = w.addJob({ status: 'PENDING' });
    const started = w.addJob({ status: 'IN_PROGRESS', artisanId: artisan });
    const mine = w.addJob({ status: 'ASSIGNED', artisanId: artisan });

    await decline(w, artisan, open);
    await failure(decline(w, artisan, started));
    expect(w.left).toEqual([]);

    await decline(w, artisan, mine);
    await decline(w, artisan, mine);
    expect(w.left).toEqual([[artisan, mine]]);
  });

  it('accepting, on the way and arrived never take anybody out of the room', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const id = w.addJob({ status: 'ASSIGNED', artisanId: artisan });

    await accept(w, artisan, id);
    await onTheWay(w, artisan, id);
    await arrived(w, artisan, id);

    expect(w.left).toEqual([]);
  });

  it('a socket server that is down does not undo the refusal, and the others are still told', async () => {
    const w = makeWorld({ leaveThrows: true });
    const artisan = w.addArtisan();
    const id = w.addJob({ status: 'ASSIGNED', artisanId: artisan });

    const answer = await decline(w, artisan, id);

    expect(answer.returnedToQueue).toBe(true);
    expect(w.job(id).artisanId).toBe(null);
    expect(w.told).toHaveLength(1);
    expect(w.live).toHaveLength(1);
  });
});

describe('the visit in the name of an artisan who refuses a job that is already open', () => {
  it('is released too (a route that did not release it left it in their name)', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const id = w.addJob({ status: 'ADMIN_REVIEW', artisanId: null });
    const visit = w.appointments.insert({
      interventionId: id,
      clientId: 1,
      artisanId: artisan,
      status: 'SCHEDULED',
      startsAt: new Date(Date.now() + 24 * 3600_000),
      endsAt: new Date(Date.now() + 2 * 24 * 3600_000),
    });

    w.reminders.insert({ appointmentId: visit.id, recipientId: artisan, minutesBefore: 120, status: 'PENDING' });

    await decline(w, artisan, id);

    expect(w.appointments.rows[0].artisanId).toBe(null);
    expect(w.reminders.rows).toEqual([]);
  });
});

// ----------------------------------------------------------
// What the second independent review of P1-06 found
// ----------------------------------------------------------

describe('a job in the queue with the id of an artisan it was taken from is open for everybody', () => {
  const takenFrom = (w: World, artisan: number, fields: Record<string, unknown> = {}) =>
    w.addJob({
      status: 'ADMIN_REVIEW',
      artisanId: artisan,
      assignedAt: new Date(1),
      artisanAcceptedAt: new Date(2),
      artisanOnTheWayAt: new Date(3),
      artisanArrivedAt: new Date(4),
      ...fields,
    });

  it('another artisan can take it: it is theirs from the beginning, with none of the dates of the road of the first', async () => {
    const w = makeWorld();
    const first = w.addArtisan();
    const second = w.addArtisan();
    const id = takenFrom(w, first);

    const row = await accept(w, second, id);

    expect(row.artisanId).toBe(second);
    expect(w.job(id)).toMatchObject({ artisanId: second, status: 'ACCEPTED', artisanOnTheWayAt: null, artisanArrivedAt: null });
    expect(w.job(id).assignedAt).not.toEqual(new Date(1));
    expect(w.job(id).artisanAcceptedAt).not.toEqual(new Date(2));
    expect(w.locks).toEqual([[71001, id], [71002, second]]); // a claim: the calendar is locked
    expect(w.told).toEqual([{ what: 'accepted', args: [id, second] }]);
    expect(w.timeline).toHaveLength(1);
  });

  it('the artisan it was taken from stops hearing about it when the next one takes it, before anything is said', async () => {
    const w = makeWorld();
    const first = w.addArtisan();
    const second = w.addArtisan();
    const id = takenFrom(w, first);

    await accept(w, second, id);

    expect(w.left).toEqual([[first, id]]);
    expect(w.order).toEqual(['leave', 'live']);
  });

  it('the same artisan taking it again starts from the beginning too, and nobody leaves the room', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const id = takenFrom(w, artisan);

    await accept(w, artisan, id);

    expect(w.job(id)).toMatchObject({ artisanId: artisan, artisanOnTheWayAt: null, artisanArrivedAt: null });
    expect(w.left).toEqual([]);
  });

  it('taking it is a claim like any: the profile, the refusals and a visit still to come are checked', async () => {
    const w = makeWorld();
    const first = w.addArtisan();
    const away = w.addArtisan({ isAcceptingJobs: false });
    const id = takenFrom(w, first);

    expect((await failure(accept(w, away, id))).getStatus()).toBe(400);
    expect(w.job(id).artisanId).toBe(first);
    expect(w.left).toEqual([]);
    silent(w);
  });

  it('a visit left in the name of the first artisan does not come with it', async () => {
    const w = makeWorld();
    const first = w.addArtisan();
    const second = w.addArtisan();
    const id = takenFrom(w, first);

    w.appointments.insert({ interventionId: id, clientId: 1, artisanId: first, status: 'SCHEDULED', startsAt: new Date(Date.now() - 3 * 24 * 3600_000), endsAt: new Date(Date.now() - 2 * 24 * 3600_000) });

    await accept(w, second, id);

    expect(w.appointments.rows[0].artisanId).toBe(null);
  });

  it('somebody else getting it between the check and the write still wins: 409, nothing written', async () => {
    const w = makeWorld({ noLockQueue: true });
    const first = w.addArtisan();
    const second = w.addArtisan();
    const third = w.addArtisan();
    const id = takenFrom(w, first);

    const update = w.interventions.update;
    w.interventions.update = async (args: any) => {
      w.interventions.rows.find((row) => row.id === id)!.artisanId = third;
      w.interventions.update = update;

      return update(args);
    };

    const error = await failure(accept(w, second, id));

    expect(error.getStatus()).toBe(409);
    expect(error.message).toMatch(/vient d’être attribuée/);
    expect(w.job(id).status).toBe('ADMIN_REVIEW');
    expect(w.job(id).artisanAcceptedAt).toEqual(new Date(2)); // nothing of ours was written
    expect(w.left).toEqual([]);
    silent(w);
  });

  it('a job in the hands of another artisan is not open, whatever its dates: the second to press gets the 409', async () => {
    for (const status of ['ASSIGNED', 'ACCEPTED', 'ON_THE_WAY', 'ARRIVED', 'IN_PROGRESS']) {
      const w = makeWorld();
      const first = w.addArtisan();
      const second = w.addArtisan();
      const id = w.addJob({ status, artisanId: first });

      expect((await failure(accept(w, second, id))).getStatus()).toBe(409);
      expect(w.job(id).artisanId).toBe(first);
      expect(w.left).toEqual([]);
    }
  });

  it('another artisan refusing it remembers their refusal and leaves the first one on it', async () => {
    const w = makeWorld();
    const first = w.addArtisan();
    const second = w.addArtisan();
    const id = takenFrom(w, first);

    const answer = await decline(w, second, id);

    expect(answer).toEqual({ message: 'Mission refusée.', returnedToQueue: false });
    expect(w.rejections.rows).toHaveLength(1);
    expect(w.job(id).artisanId).toBe(first); // not theirs to clear
    expect(w.left).toEqual([]);
    silent(w);
  });

  it('on the way and arrived are still not for somebody who does not have the job', async () => {
    const w = makeWorld();
    const first = w.addArtisan();
    const second = w.addArtisan();
    const id = takenFrom(w, first);

    expect((await failure(onTheWay(w, second, id))).getStatus()).toBe(403);
    expect((await failure(arrived(w, second, id))).getStatus()).toBe(403);
  });
});

describe('giving a mission back twice', () => {
  it('after somebody else took it: the second press is answered like the first, and nothing moves', async () => {
    const w = makeWorld();
    const first = w.addArtisan();
    const second = w.addArtisan();
    const id = w.addJob({ status: 'ASSIGNED', artisanId: first });

    await decline(w, first, id);
    await accept(w, second, id);

    w.told.length = 0;
    w.timeline.length = 0;
    w.live.length = 0;
    w.left.length = 0;

    const again = await decline(w, first, id);

    expect(again).toEqual({ message: 'Mission refusée.', returnedToQueue: false });
    expect(w.job(id)).toMatchObject({ artisanId: second, status: 'ACCEPTED' });
    expect(w.rejections.rows).toHaveLength(1);
    expect(w.left).toEqual([]);
    silent(w);
  });

  it('only the "not yours" answer is made quiet: a job that does not exist is still a 404', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();

    // A line left for a job that is gone (a database without the foreign key, a restored backup).
    w.rejections.insert({ artisanProfileId: w.profiles.rows[0].id, interventionId: 99, reason: 'TOO_FAR' });

    expect((await failure(decline(w, artisan, 99))).getStatus()).toBe(404);
  });

  it('without having given it back, a job that is somebody else\'s is still a 403', async () => {
    const w = makeWorld();
    const first = w.addArtisan();
    const second = w.addArtisan();
    const id = w.addJob({ status: 'ASSIGNED', artisanId: second });

    expect((await failure(decline(w, first, id))).getStatus()).toBe(403);
    expect(w.rejections.rows).toEqual([]);
  });
});

describe('the visit of a job given back', () => {
  const visit = (w: World, id: number, artisan: number, fields: Record<string, unknown> = {}) =>
    w.appointments.insert({
      interventionId: id,
      clientId: 1,
      artisanId: artisan,
      status: 'CONFIRMED',
      confirmedAt: new Date(10),
      startsAt: new Date(Date.now() + 2 * 24 * 3600_000),
      endsAt: new Date(Date.now() + 2 * 24 * 3600_000 + 3600_000),
      ...fields,
    });

  it('a visit still to come that the artisan had confirmed is not confirmed by anybody: planned again, nobody\'s name, its time kept', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const id = w.addJob({ status: 'ACCEPTED', artisanId: artisan });
    const planned = visit(w, id, artisan);

    await decline(w, artisan, id);

    expect(w.appointments.rows[0]).toMatchObject({ status: 'SCHEDULED', confirmedAt: null, artisanId: null });
    expect(w.appointments.rows[0].startsAt).toEqual(planned.startsAt);
  });

  it('a visit that is over is history: it stays as it was', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const id = w.addJob({ status: 'ACCEPTED', artisanId: artisan });

    visit(w, id, artisan, { startsAt: new Date(Date.now() - 3 * 24 * 3600_000), endsAt: new Date(Date.now() - 2 * 24 * 3600_000) });

    await decline(w, artisan, id);

    expect(w.appointments.rows[0]).toMatchObject({ status: 'CONFIRMED', artisanId: null });
    expect(w.appointments.rows[0].confirmedAt).toEqual(new Date(10));
  });

  it('a visit that is not the artisan\'s is not touched', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const other = w.addArtisan();
    const id = w.addJob({ status: 'ACCEPTED', artisanId: artisan });

    visit(w, id, other);
    await decline(w, artisan, id);

    expect(w.appointments.rows[0]).toMatchObject({ status: 'CONFIRMED', artisanId: other });
  });
});

describe('taking an open mission is limited to the artisan\'s trades and zones (P1-11)', () => {
  const TUNIS = { latitude: 36.8065, longitude: 10.1815 };
  const SFAX = { latitude: 34.7406, longitude: 10.7603 };
  const zone = (over: Record<string, unknown> = {}) => ({ ...TUNIS, radiusKm: 20, isActive: true, ...over });

  it('a job outside every zone of the artisan is a 403, and nothing moves', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan({ serviceZones: [zone()] });
    const id = w.addJob({ status: 'PENDING', serviceType: 'PLOMBIER', ...SFAX });

    const error = await failure(accept(w, artisan, id));

    expect(error.getStatus()).toBe(403);
    expect(error.message).toContain('zones');
    expect(w.job(id).artisanId).toBe(null);
    expect(w.job(id).status).toBe('PENDING');
    silent(w);
  });

  it('a job inside a zone is taken', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan({ serviceZones: [zone()] });
    const id = w.addJob({ status: 'PENDING', serviceType: 'PLOMBIER', latitude: 36.85, longitude: 10.2 });

    await accept(w, artisan, id);

    expect(w.job(id).artisanId).toBe(artisan);
  });

  it('a job of another trade is a 403 too, even when it is next door', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan({ serviceTypes: ['PLOMBIER'] });
    const id = w.addJob({ status: 'PENDING', serviceType: 'SERRURIER', ...TUNIS });

    const error = await failure(accept(w, artisan, id));

    expect(error.getStatus()).toBe(403);
    expect(w.job(id).artisanId).toBe(null);
  });

  it('an artisan with no trade and no zone, and a job with no position, are not limited', async () => {
    const w = makeWorld();
    const free = w.addArtisan();
    const zoned = w.addArtisan({ serviceZones: [zone()] });
    const far = w.addJob({ status: 'PENDING', serviceType: 'VITRIER', ...SFAX });
    const unplaced = w.addJob({ status: 'PENDING', serviceType: 'PLOMBIER', latitude: null, longitude: null });

    await accept(w, free, far);
    await accept(w, zoned, unplaced);

    expect(w.job(far).artisanId).toBe(free);
    expect(w.job(unplaced).artisanId).toBe(zoned);
  });

  it('a job the back office gave is accepted wherever it is: the dispatcher chose the artisan', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan({ serviceTypes: ['PLOMBIER'], serviceZones: [zone()] });
    const id = w.addJob({ status: 'ASSIGNED', artisanId: artisan, serviceType: 'SERRURIER', ...SFAX });

    await accept(w, artisan, id);

    expect(w.job(id).status).toBe('ACCEPTED');
  });

  it('the artisan\'s zones are read when the job is taken (the profile is loaded with them)', async () => {
    const w = makeWorld();
    const asked: any[] = [];
    const original = (w.service as any).prisma.artisanProfile.findUnique;

    (w.service as any).prisma.artisanProfile.findUnique = async (args: any) => {
      asked.push(args);

      return original(args);
    };

    const artisan = w.addArtisan();
    const id = w.addJob({ status: 'PENDING', serviceType: 'PLOMBIER' });

    await accept(w, artisan, id);

    expect(asked[0].include).toEqual({ availability: true, serviceZones: true });
  });
});
