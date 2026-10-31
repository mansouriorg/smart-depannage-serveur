import { ConflictException } from '@nestjs/common';
import { SchedulingService } from './scheduling.service';

/**
 * Accepting a scheduled mission: the artisan's acceptance is the mission service's action
 * (P1-06), so the lock, the dates, the timeline, the messages to the client and the back
 * office, and the live event are the same whichever route the app uses. Only the visit is
 * confirmed here.
 */

function makeWorld(options: { acceptFails?: boolean; withoutMissionActions?: boolean; visitStatus?: string; statusUnderTheLock?: string; noTime?: boolean; noTimeUnderTheLock?: boolean; artisanUnderTheLock?: number; jobStatus?: string; jobStatusAtTheFirstLook?: string } = {}) {
  let visitReads = 0;
  const accepted: any[] = [];
  const locks: any[] = [];
  const order: string[] = [];
  const requestWrites: any[] = [];
  const confirmed: any[] = [];
  const told: any[] = [];
  const live: any[] = [];
  const job: any = { id: 8, status: options.jobStatus ?? 'ASSIGNED', artisanId: 4 };

  const prisma: any = {
    appointment: {
      findUnique: async ({ where }: any) => ({
        id: where.id,
        interventionId: 8,
        clientId: 2,
        artisanId: visitReads > 0 && options.artisanUnderTheLock !== undefined ? options.artisanUnderTheLock : 4,
        startsAt: options.noTime || (visitReads > 0 && options.noTimeUnderTheLock) ? null : new Date('2026-11-10T09:00:00.000Z'),
        // the first look is the access check; the next ones are made under the lock
        status: (visitReads += 1) > 1 && options.statusUnderTheLock ? options.statusUnderTheLock : (options.visitStatus ?? 'SCHEDULED'),
        requests: [],
        reminders: [],
        intervention: { ...job, ...(visitReads <= 1 && options.jobStatusAtTheFirstLook ? { status: options.jobStatusAtTheFirstLook } : {}) },
      }),
      update: async (args: any) => {
        confirmed.push(args);

        return { id: args.where.id, status: options.visitStatus ?? 'SCHEDULED', ...args.data };
      },
    },
    appointmentRequest: {
      updateMany: async (args: any) => {
        requestWrites.push(args);

        return { count: 1 };
      },
    },
    intervention: {
      findUnique: async () => ({ ...job }),
      update: async ({ data }: any) => {
        order.push('status');

        return Object.assign(job, data);
      },
    },
    $executeRaw: async (...args: any[]) => {
      order.push('lock');

      return locks.push(args);
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
    locks,
    order,
    requestWrites,
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

  it('the visit is confirmed under the lock of the job (P3-01)', async () => {
    const w = makeWorld();

    await w.service.acceptScheduledMission(4, 'ARTISAN' as any, 31);

    expect(w.locks).toHaveLength(1);
    expect(w.requestWrites).toEqual([]);
  });

  it.each(['RESCHEDULE_REQUESTED', 'CANCEL_REQUESTED'])('a visit that shows a request still waiting (%s) keeps showing it: the confirmation is written, and the waiting requests remember it (P3-01)', async (visitStatus) => {
    const w = makeWorld({ visitStatus });

    const visit: any = await w.service.acceptScheduledMission(4, 'ARTISAN' as any, 31);

    expect(w.confirmed).toHaveLength(1);
    expect(w.confirmed[0].data.status).toBeUndefined();
    expect(w.confirmed[0].data.confirmedAt).toBeInstanceOf(Date);
    expect(w.requestWrites).toHaveLength(1);
    expect(w.requestWrites[0].where).toEqual({ appointmentId: 31, status: 'PENDING' });
    expect(w.requestWrites[0].data).toEqual({ previousStatus: 'CONFIRMED' });
    expect(visit.status).toBe(visitStatus);
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

  it.each(['CANCELLED', 'COMPLETED', 'NO_SHOW'])('a visit that is %s cannot be accepted: 409, the mission is not accepted and nothing is written (P3-01)', async (visitStatus) => {
    const w = makeWorld({ visitStatus });
    const error = await failure(w.service.acceptScheduledMission(4, 'ARTISAN' as any, 31));

    expect(error.getStatus()).toBe(409);
    expect(w.accepted).toEqual([]);
    expect(w.confirmed).toEqual([]);
  });

  it('a visit cancelled while the mission was being accepted is not brought back to life', async () => {
    const w = makeWorld({ statusUnderTheLock: 'CANCELLED' });

    const visit: any = await w.service.acceptScheduledMission(4, 'ARTISAN' as any, 31);

    expect(w.accepted).toHaveLength(1);
    expect(w.confirmed).toEqual([]);
    expect(visit.status).toBe('CANCELLED');
  });

  it('a visit with no time planned has nothing to accept: 409, the mission is not accepted and nothing is written (P3-01)', async () => {
    const w = makeWorld({ noTime: true });
    const error = await failure(w.service.acceptScheduledMission(4, 'ARTISAN' as any, 31));

    expect(error.getStatus()).toBe(409);
    expect(w.accepted).toEqual([]);
    expect(w.confirmed).toEqual([]);
  });

  it('a visit whose hour was taken away while the mission was being accepted is not confirmed with no hour', async () => {
    const w = makeWorld({ noTimeUnderTheLock: true });

    const visit: any = await w.service.acceptScheduledMission(4, 'ARTISAN' as any, 31);

    expect(w.accepted).toHaveLength(1);
    expect(w.confirmed).toEqual([]);
    expect(visit.startsAt).toBe(null);
  });

  it('a visit handed to another artisan while the mission was being accepted is not confirmed in the name of the new one', async () => {
    const w = makeWorld({ artisanUnderTheLock: 5 });

    const visit: any = await w.service.acceptScheduledMission(4, 'ARTISAN' as any, 31);

    expect(w.accepted).toHaveLength(1);
    expect(w.confirmed).toEqual([]);
    expect(visit.artisanId).toBe(5);
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
  it('a visit that was cancelled cannot be accepted for the artisan either', async () => {
    const w = makeWorld({ visitStatus: 'CANCELLED' });
    const error = await failure(w.service.acceptScheduledMission(1, 'ADMIN' as any, 31));

    expect(error.getStatus()).toBe(409);
    expect(w.confirmed).toEqual([]);
    expect(w.told).toEqual([]);
  });

  it('takes the lock of the job before it writes the status, as everyone who takes both does (P3-01)', async () => {
    const w = makeWorld();

    await w.service.acceptScheduledMission(1, 'ADMIN' as any, 31);

    expect(w.order.indexOf('lock')).toBeGreaterThanOrEqual(0);
    expect(w.order.indexOf('lock')).toBeLessThan(w.order.indexOf('status'));
  });

  it('a visit handed to another artisan since it was read is not accepted for the old one: 409, nothing is written', async () => {
    const w = makeWorld({ artisanUnderTheLock: 5 });
    const error = await failure(w.service.acceptScheduledMission(1, 'ADMIN' as any, 31));

    expect(error.getStatus()).toBe(409);
    expect(w.job.status).toBe('ASSIGNED');
    expect(w.confirmed).toEqual([]);
    expect(w.told).toEqual([]);
  });

  it('a visit with no time planned has nothing to accept for the artisan either', async () => {
    const w = makeWorld({ noTime: true });
    const error = await failure(w.service.acceptScheduledMission(1, 'ADMIN' as any, 31));

    expect(error.getStatus()).toBe(409);
    expect(w.job.status).toBe('ASSIGNED');
    expect(w.confirmed).toEqual([]);
  });

  it('moves the status through the table, confirms the visit and tells the client and the dashboards', async () => {
    const w = makeWorld();

    await w.service.acceptScheduledMission(1, 'ADMIN' as any, 31);

    expect(w.accepted).toEqual([]); // not the artisan's action
    expect(String(w.job.status)).toMatch(/ACCEPTED/);
    expect(w.confirmed).toHaveLength(1);
    expect(w.told).toHaveLength(1);
    expect(w.live).toHaveLength(1);
  });

  it.each(['ARTISAN_ON_THE_WAY', 'ARTISAN_ARRIVED', 'IN_PROGRESS', 'WAITING_CLIENT_VALIDATION'])(
    'a job that is %s is never put back to accepted: the visit is confirmed, the job is left alone and nobody is told it was accepted (P3-01)',
    async (jobStatus) => {
      const w = makeWorld({ jobStatus });

      const visit: any = await w.service.acceptScheduledMission(1, 'ADMIN' as any, 31);

      expect(w.job.status).toBe(jobStatus);
      expect(w.job.artisanAcceptedAt).toBeUndefined();
      expect(w.confirmed).toHaveLength(1);
      expect(visit.status).toBe('CONFIRMED');
      expect(w.told).toEqual([]);
      expect(w.live).toEqual([]);
    },
  );

  it('a job that is already accepted keeps its date of acceptance, and the customer is not told twice', async () => {
    const w = makeWorld({ jobStatus: 'ARTISAN_ACCEPTED' });

    await w.service.acceptScheduledMission(1, 'ADMIN' as any, 31);

    expect(w.job.status).toBe('ARTISAN_ACCEPTED');
    expect(w.job.artisanAcceptedAt).toBeUndefined();
    expect(w.confirmed).toHaveLength(1);
    expect(w.told).toEqual([]);
  });

  it.each(['COMPLETED', 'PAYMENT_PENDING', 'PAID', 'INVOICE_SENT', 'CANCELLED', 'DISPUTED'])(
    'a job that is %s is not accepted for the artisan: 409 and nothing is written (P3-01)',
    async (jobStatus) => {
      const w = makeWorld({ jobStatus });
      const error = await failure(w.service.acceptScheduledMission(1, 'ADMIN' as any, 31));

      expect(error.getStatus()).toBe(409);
      expect(w.job.status).toBe(jobStatus);
      expect(w.confirmed).toEqual([]);
      expect(w.told).toEqual([]);
      expect(w.live).toEqual([]);
    },
  );

  it('a visit that is only asked for (REQUESTED) holds no hour: even with a leftover hour, it is not accepted for the artisan', async () => {
    const w = makeWorld({ visitStatus: 'REQUESTED' });
    const error = await failure(w.service.acceptScheduledMission(1, 'ADMIN' as any, 31));

    expect(error.getStatus()).toBe(409);
    expect(w.job.status).toBe('ASSIGNED');
    expect(w.confirmed).toEqual([]);
  });

  it('a visit that became REQUESTED while the mission was being accepted is not confirmed with its old hour', async () => {
    const w = makeWorld({ statusUnderTheLock: 'REQUESTED' });

    await w.service.acceptScheduledMission(4, 'ARTISAN' as any, 31);

    expect(w.confirmed).toEqual([]);
  });

  it('the dashboards are told the status the job really had under the lock, not the one read before it', async () => {
    const w = makeWorld({ jobStatusAtTheFirstLook: 'WAITING_ADMIN_REVIEW' });

    await w.service.acceptScheduledMission(1, 'ADMIN' as any, 31);

    expect(w.live[0]).toMatchObject({ interventionId: 8, oldStatus: 'ASSIGNED', newStatus: 'ARTISAN_ACCEPTED' });
  });

  for (const [jobStatus, words] of [
    ['COMPLETED', 'terminée'],
    ['PAYMENT_PENDING', 'terminée'],
    ['PAID', 'terminée'],
    ['INVOICE_SENT', 'terminée'],
    ['CANCELLED', 'annulée'],
    ['DISPUTED', 'en litige'],
  ]) {
    it(`a job that is ${jobStatus} says so when the acceptance is refused`, async () => {
      const w = makeWorld({ jobStatus });
      const error = await failure(w.service.acceptScheduledMission(1, 'ADMIN' as any, 31));

      expect(String(error.message)).toContain(words);
    });
  }

  it('a job that is cancelled under the lock, after the visit was read as fine, is not accepted', async () => {
    const w = makeWorld({ jobStatusAtTheFirstLook: 'ASSIGNED', jobStatus: 'CANCELLED' });
    const error = await failure(w.service.acceptScheduledMission(1, 'ADMIN' as any, 31));

    expect(error.getStatus()).toBe(409);
    expect(w.job.status).toBe('CANCELLED');
    expect(w.confirmed).toEqual([]);
    expect(w.told).toEqual([]);
  });
});
