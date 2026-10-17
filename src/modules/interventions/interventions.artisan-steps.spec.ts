import { FakeTable } from '../../common/testing/fake-tables';
import { InterventionsService } from './interventions.service';

/**
 * PATCH /interventions/:id is the route the deployed mobile app uses for "I am on my way" and
 * "I have arrived" (and, still, for "the work started"). The two steps are the mission
 * service's (P1-06): one lock, one date, one line in the timeline, the client and the back
 * office told. The route used to change the status and nothing else.
 */

const secrets = {
  adminInternalNotes: 'client difficile',
  adminReviewStartedAt: new Date(5),
  trackingToken: 'hash-of-the-link',
  cancelledById: 9,
};

function makeWorld() {
  const interventions = new FakeTable({
    defaults: () => ({ status: 'ACCEPTED', artisanId: null, clientId: 2, ...secrets }),
  });
  const profiles = new FakeTable({ unique: ['userId'] });
  const calls: Array<{ name: string; input: any }> = [];
  const sockets: any[] = [];
  const queries: any[] = [];

  const record = (name: string) => async (input: any) => {
    calls.push({ name, input });

    return { from: name };
  };

  const missionActions: any = { onTheWay: record('onTheWay'), arrived: record('arrived') };
  const prisma: any = {
    intervention: {
      findUnique: (args: any) => interventions.findUnique(args),
      update: (args: any) => interventions.update(args),
      findMany: async (args: any) => {
        queries.push(args);

        return interventions.rows.filter((row) => ['CREATED'].includes(row.status));
      },
    },
    artisanProfile: { findUnique: (args: any) => profiles.findUnique(args) },
  };
  const gateway: any = { sendInterventionStatus: (payload: any) => sockets.push(payload) };

  return {
    service: new InterventionsService(prisma, gateway, {} as any, {} as any, {} as any, missionActions, {} as any),
    interventions,
    profiles,
    calls,
    sockets,
    queries,
    gateway,
    missionActions,
  };
}

async function failure(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('expected a failure');
}

describe('the artisan\'s steps through PATCH /interventions/:id (P1-06)', () => {
  it('on the way, in either spelling, is the mission service\'s step, for the artisan who asks', async () => {
    for (const status of ['ON_THE_WAY', 'ARTISAN_ON_THE_WAY']) {
      const w = makeWorld();
      const row = w.interventions.insert({ artisanId: 4, status: 'ACCEPTED' });

      const answer = await w.service.updateAsArtisan(row.id, 4, { status } as any);

      expect(answer).toEqual({ from: 'onTheWay' });
      expect(w.calls).toHaveLength(1);
      expect(w.calls[0].input).toMatchObject({ userId: 4, interventionId: row.id });
      // The answer keeps the shape this route has always had: the client and the artisan.
      expect(Object.keys(w.calls[0].input.include)).toEqual(['client', 'artisan']);
      expect(w.interventions.rows[0].status).toBe('ACCEPTED'); // this route wrote nothing itself
      // The dashboard that still listens on the first socket gets the change, as it always did.
      expect(w.sockets).toEqual([{ from: 'onTheWay' }]);
    }
  });

  it('a first socket that fails does not turn a step that was made into an error', async () => {
    const w = makeWorld();
    const row = w.interventions.insert({ artisanId: 4, status: 'ACCEPTED' });

    w.gateway.sendInterventionStatus = () => {
      throw new Error('socket server down');
    };

    expect(await w.service.updateAsArtisan(row.id, 4, { status: 'ON_THE_WAY' } as any)).toEqual({ from: 'onTheWay' });
    expect(await w.service.updateAsArtisan(row.id, 4, { status: 'ARRIVED' } as any)).toEqual({ from: 'arrived' });
  });

  it('a step that is refused sends nothing on the first socket', async () => {
    const w = makeWorld();
    const row = w.interventions.insert({ artisanId: 4, status: 'ACCEPTED' });

    w.missionActions.onTheWay = async () => {
      throw new Error('409');
    };

    await failure(w.service.updateAsArtisan(row.id, 4, { status: 'ON_THE_WAY' } as any));

    expect(w.sockets).toEqual([]);
  });

  it('arrived, in either spelling', async () => {
    for (const status of ['ARRIVED', 'ARTISAN_ARRIVED']) {
      const w = makeWorld();
      const row = w.interventions.insert({ artisanId: 4, status: 'ON_THE_WAY' });

      expect(await w.service.updateAsArtisan(row.id, 4, { status } as any)).toEqual({ from: 'arrived' });
      expect(w.calls.map((c) => c.name)).toEqual(['arrived']);
      expect(w.sockets).toEqual([{ from: 'arrived' }]);
    }
  });

  it('a job that is not theirs is not found, and the mission service is not called', async () => {
    const w = makeWorld();
    const row = w.interventions.insert({ artisanId: 9, status: 'ACCEPTED' });

    expect((await failure(w.service.updateAsArtisan(row.id, 4, { status: 'ON_THE_WAY' } as any))).getStatus()).toBe(404);
    expect((await failure(w.service.updateAsArtisan(777, 4, { status: 'ON_THE_WAY' } as any))).getStatus()).toBe(404);
    expect(w.calls).toEqual([]);
  });

  it('anything else than a status is still refused, and so is a status an artisan may not set', async () => {
    const w = makeWorld();
    const row = w.interventions.insert({ artisanId: 4, status: 'ACCEPTED' });

    expect((await failure(w.service.updateAsArtisan(row.id, 4, { status: 'ON_THE_WAY', title: 'x' } as any))).getStatus()).toBe(403);
    expect((await failure(w.service.updateAsArtisan(row.id, 4, { status: 'COMPLETED' } as any))).getStatus()).toBe(403);
    expect((await failure(w.service.updateAsArtisan(row.id, 4, { artisanId: 5 } as any))).getStatus()).toBe(403);
    expect(w.calls).toEqual([]);
  });

  it('"the work started" stays on the general update (the app still sends it), without the notes of the back office', async () => {
    const w = makeWorld();
    const row = w.interventions.insert({ artisanId: 4, status: 'ARRIVED' });

    const answer: any = await w.service.updateAsArtisan(row.id, 4, { status: 'IN_PROGRESS' } as any);

    expect(w.calls).toEqual([]);
    expect(w.interventions.rows[0].status).toBe('IN_PROGRESS');
    expect(answer.status).toBe('IN_PROGRESS');
    for (const key of Object.keys(secrets)) expect(key in answer).toBe(false);
    expect(w.interventions.rows[0].adminInternalNotes).toBe('client difficile'); // still on the job
  });
});

describe('the marketplace of the old route does not offer again a job the artisan refused (P1-06)', () => {
  it('filters on the refusals of the artisan\'s profile', async () => {
    const w = makeWorld();

    w.profiles.insert({ userId: 4 });
    w.interventions.insert({ status: 'CREATED' });

    await w.service.findAllPending(4);

    expect(w.queries[0].where.missionRejections).toEqual({ none: { artisanProfileId: w.profiles.rows[0].id } });
  });

  it('without a profile, or without a user, there is no refusal to filter on', async () => {
    const w = makeWorld();

    await w.service.findAllPending(4); // no profile
    await w.service.findAllPending();

    expect(w.queries.every((q) => !('missionRejections' in q.where))).toBe(true);
  });

  it('still hides the staff data and the way to reach the client', async () => {
    const w = makeWorld();

    w.interventions.insert({ status: 'CREATED', contactPhone: '+21620000000', contactEmail: 'x@y.tn', contactName: 'X' });

    const [row]: any[] = await w.service.findAllPending();

    for (const key of [...Object.keys(secrets), 'contactPhone', 'contactEmail', 'contactName']) expect(key in row).toBe(false);
  });
});
