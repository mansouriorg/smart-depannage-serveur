import { ConflictException } from '@nestjs/common';
import { SchedulingService } from './scheduling.service';

/**
 * Accepting a scheduled mission: the artisan's acceptance is the mission service's action
 * (P1-06), so the lock, the dates, the timeline, the messages to the client and the back
 * office, and the live event are the same whichever route the app uses. Only the visit is
 * confirmed here.
 */

function makeWorld(options: { acceptFails?: boolean; withoutMissionActions?: boolean } = {}) {
  const accepted: any[] = [];
  const confirmed: any[] = [];
  const told: any[] = [];
  const live: any[] = [];
  const job: any = { id: 8, status: 'ASSIGNED', artisanId: 4 };

  const prisma: any = {
    appointment: {
      findUnique: async ({ where }: any) => ({
        id: where.id,
        interventionId: 8,
        clientId: 2,
        artisanId: 4,
        requests: [],
        reminders: [],
        intervention: { ...job },
      }),
      update: async (args: any) => {
        confirmed.push(args);

        return { id: args.where.id, ...args.data };
      },
    },
    intervention: {
      findUnique: async () => ({ ...job }),
      update: async ({ data }: any) => Object.assign(job, data),
    },
  };
  prisma.$transaction = async (work: any) => work(prisma);

  const missionActions: any = {
    accept: async (input: any) => {
      if (options.acceptFails) throw new ConflictException('Cette mission vient d’être attribuée à un autre artisan ou n’est plus disponible.');
      accepted.push(input);

      return { id: 8 };
    },
  };
  const notifications: any = { notify: async (...args: any[]) => told.push(args) };
  const realtime: any = { emitStatusChange: async (payload: any) => live.push(payload) };

  return {
    service: new SchedulingService(
      prisma,
      {} as any,
      notifications,
      realtime,
      options.withoutMissionActions ? undefined : missionActions,
    ),
    accepted,
    confirmed,
    told,
    live,
    job,
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

describe('an artisan accepting a scheduled mission (P1-06)', () => {
  it('is the mission service\'s action, then the visit is confirmed', async () => {
    const w = makeWorld();

    const visit: any = await w.service.acceptScheduledMission(4, 'ARTISAN' as any, 31);

    expect(w.accepted).toEqual([{ userId: 4, interventionId: 8 }]);
    expect(w.confirmed).toHaveLength(1);
    expect(w.confirmed[0].where).toEqual({ id: 31 });
    expect(w.confirmed[0].data.status).toBe('CONFIRMED');
    expect(w.confirmed[0].data.confirmedAt).toBeInstanceOf(Date);
    expect(visit.status).toBe('CONFIRMED');
  });

  it('does not write the status, tell the client or send the live event itself (the mission service does, once)', async () => {
    const w = makeWorld();

    await w.service.acceptScheduledMission(4, 'ARTISAN' as any, 31);

    expect(w.job.status).toBe('ASSIGNED');
    expect(w.told).toEqual([]);
    expect(w.live).toEqual([]);
  });

  it('when the acceptance is refused, the visit is not confirmed and the refusal reaches the artisan', async () => {
    const w = makeWorld({ acceptFails: true });

    const error = await failure(w.service.acceptScheduledMission(4, 'ARTISAN' as any, 31));

    expect(error.getStatus()).toBe(409);
    expect(w.confirmed).toEqual([]);
  });

  it('only the artisan of the visit: another artisan is refused and nothing is called', async () => {
    const w = makeWorld();

    const error = await failure(w.service.acceptScheduledMission(9, 'ARTISAN' as any, 31));

    expect(error.getStatus()).toBe(403);
    expect(w.accepted).toEqual([]);
    expect(w.confirmed).toEqual([]);
  });

  it('never falls back to changing the status alone when the mission service is missing', async () => {
    const w = makeWorld({ withoutMissionActions: true });

    const error = await failure(w.service.acceptScheduledMission(4, 'ARTISAN' as any, 31));

    expect(error.message).toMatch(/mission actions are not available/);
    expect(w.job.status).toBe('ASSIGNED');
    expect(w.confirmed).toEqual([]);
  });
});

describe('staff accepting a scheduled mission for the artisan', () => {
  it('moves the status through the table, confirms the visit and tells the client and the dashboards', async () => {
    const w = makeWorld();

    await w.service.acceptScheduledMission(1, 'ADMIN' as any, 31);

    expect(w.accepted).toEqual([]); // not the artisan's action
    expect(String(w.job.status)).toMatch(/ACCEPTED/);
    expect(w.confirmed).toHaveLength(1);
    expect(w.told).toHaveLength(1);
    expect(w.live).toHaveLength(1);
  });
});
