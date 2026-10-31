import { SchedulingService } from './scheduling.service';

/**
 * Who may set the time of a visit, and what the customer and the artisan read of it (P1-17). The route-level
 * check with two households is in src/common/testing/access/scheduling.ts; these are the plain cases.
 */

const CLIENT = 2;
const ARTISAN = 4;
const STRANGER = 9;

function makeService(visit: { status?: string; jobStatus?: string; jobAfterTheCheck?: Record<string, any>; noVisit?: boolean } = {}) {
  const job: any = {
    id: 8,
    clientId: CLIENT,
    artisanId: ARTISAN,
    status: visit.jobStatus ?? 'ASSIGNED',
    client: { id: CLIENT, name: 'Sami', email: 'sami@example.test', phone: '20 111 111', role: 'CLIENT' },
    artisan: { id: ARTISAN, name: 'Karim', email: 'karim@example.test', phone: '20 222 222', role: 'ARTISAN' },
  };
  const row: any = {
    id: 3,
    interventionId: 8,
    clientId: CLIENT,
    artisanId: ARTISAN,
    // A visit that nobody has planned yet: the customer's wish is all it holds (a planned visit is moved by a request, P3-01).
    status: visit.status ?? 'REQUESTED',
    adminNote: 'NOTE-OF-THE-BACK-OFFICE',
    scheduledById: 77,
    reminders: [{ id: 1, error: 'REMINDER-ERROR' }],
    requests: [],
    client: job.client,
    artisan: job.artisan,
  };
  const writes: any[] = [];
  const locks: any[] = [];
  let jobReads = 0;
  const prisma: any = {
    $transaction: async (work: any) => work(prisma),
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      locks.push([strings.join('?'), ...values]);

      return 1;
    },
    intervention: {
      // The first look is the access check; the next ones are made under the lock. `jobAfterTheCheck` is what changed in between.
      findUnique: async () => {
        jobReads += 1;

        return { ...job, ...(jobReads > 1 ? visit.jobAfterTheCheck ?? {} : {}) };
      },
      update: async (args: any) => {
        writes.push(['intervention', args]);

        return job;
      },
    },
    appointment: {
      findUnique: async () => (visit.noVisit ? null : { ...row }),
      upsert: async (args: any) => {
        writes.push(['appointment', args]);

        return { ...row, ...args.update };
      },
    },
  };

  return { service: new SchedulingService(prisma, {} as any, {} as any, {} as any), writes, locks };
}

async function failure(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('expected a failure');
}

const TIME: any = { preferredDate: '2026-11-03', preferredStartTime: '09:00', preferredEndTime: '11:00' };

describe('the time of a visit is the customer\'s to give (P1-17)', () => {
  it('lets the customer of the job set it, and answers without the back office\'s note', async () => {
    const { service, writes } = makeService();
    const visit = await service.choosePreferredTime(CLIENT, 'CLIENT' as any, 8, TIME);

    expect(writes).toHaveLength(2);
    expect(visit.status).toBe('REQUESTED');
    expect(visit).not.toHaveProperty('adminNote');
    expect(visit).not.toHaveProperty('scheduledById');
    expect(JSON.stringify(visit)).not.toContain('NOTE-OF-THE-BACK-OFFICE');
  });

  it('refuses the artisan of the job, and writes nothing', async () => {
    const { service, writes } = makeService();
    const error = await failure(service.choosePreferredTime(ARTISAN, 'ARTISAN' as any, 8, TIME));

    expect(error.getStatus()).toBe(403);
    expect(writes).toHaveLength(0);
  });

  it('refuses another customer, and writes nothing', async () => {
    const { service, writes } = makeService();
    const error = await failure(service.choosePreferredTime(STRANGER, 'CLIENT' as any, 8, TIME));

    expect(error.getStatus()).toBe(403);
    expect(writes).toHaveLength(0);
  });

  it('lets the back office set it for the customer, and gives it the row', async () => {
    const { service, writes } = makeService();
    const visit = await service.choosePreferredTime(1, 'DISPATCHER' as any, 8, TIME);

    expect(writes).toHaveLength(2);
    expect(visit.adminNote).toBe('NOTE-OF-THE-BACK-OFFICE');
  });

  it('the customer of the job is checked again under the lock: a job that changed hands since the first look is not written (P3-01)', async () => {
    const { service, writes } = makeService({ jobAfterTheCheck: { clientId: STRANGER } });
    const error = await failure(service.choosePreferredTime(CLIENT, 'CLIENT' as any, 8, TIME));

    expect(error.getStatus()).toBe(403);
    expect(writes).toHaveLength(0);
  });

  it('the back office is not a customer: the same change does not stop it', async () => {
    const { service, writes } = makeService({ jobAfterTheCheck: { clientId: STRANGER } });

    await service.choosePreferredTime(1, 'DISPATCHER' as any, 8, TIME);

    expect(writes).toHaveLength(2);
  });

  it('a visit made by the back office for the customer is the customer\'s, not the desk\'s (P3-01)', async () => {
    const { service, writes } = makeService({ noVisit: true });

    await service.choosePreferredTime(1, 'DISPATCHER' as any, 8, TIME);

    const create = writes.find(([table]) => table === 'appointment')?.[1].create;

    expect(create.clientId).toBe(CLIENT);
    expect(create.artisanId).toBe(ARTISAN);
    expect(create.status).toBe('REQUESTED');
  });

  it('a job that is gone under the lock is a 404, and nothing is written (P3-01)', async () => {
    const { service, writes } = makeService();
    const original = (service as any).prisma.intervention.findUnique;
    let reads = 0;

    (service as any).prisma.intervention.findUnique = async (args: any) => {
      reads += 1;

      return reads > 1 ? null : original(args);
    };

    const error = await failure(service.choosePreferredTime(CLIENT, 'CLIENT' as any, 8, TIME));

    expect(error.getStatus()).toBe(404);
    expect(writes).toHaveLength(0);
  });

  it('is written under the lock of the job, the same lock every other write of the visit takes (P3-01)', async () => {
    const { service, locks } = makeService();

    await service.choosePreferredTime(CLIENT, 'CLIENT' as any, 8, TIME);

    expect(locks).toHaveLength(1);
    expect(locks[0].slice(1)).toContain(8);
  });
});

describe('a customer cannot free a planned visit by choosing a time (P3-01)', () => {
  // "REQUESTED" does not hold the artisan's calendar: the visit used to be put there, and the hour was free for another booking.
  it.each(['SCHEDULED', 'CONFIRMED', 'RESCHEDULE_REQUESTED', 'CANCEL_REQUESTED'])('a visit that is %s: 409, nothing is written', async (status) => {
    const { service, writes } = makeService({ status });
    const error = await failure(service.choosePreferredTime(CLIENT, 'CLIENT' as any, 8, TIME));

    expect(error.getStatus()).toBe(409);
    expect(String(error.message)).toContain('report');
    expect(writes).toHaveLength(0);
  });

  it('the back office is held to the same: it moves a planned visit by planning it again, not by this route', async () => {
    const { service, writes } = makeService({ status: 'CONFIRMED' });
    const error = await failure(service.choosePreferredTime(1, 'DISPATCHER' as any, 8, TIME));

    expect(error.getStatus()).toBe(409);
    expect(writes).toHaveLength(0);
  });

  it('a visit that took place is not reopened', async () => {
    const { service, writes } = makeService({ status: 'COMPLETED' });
    const error = await failure(service.choosePreferredTime(CLIENT, 'CLIENT' as any, 8, TIME));

    expect(error.getStatus()).toBe(409);
    expect(writes).toHaveLength(0);
  });

  it.each(['CANCELLED', 'NO_SHOW', 'REQUESTED'])('a visit that is %s can be asked for again: it goes back to "requested"', async (status) => {
    const { service, writes } = makeService({ status });
    const visit = await service.choosePreferredTime(CLIENT, 'CLIENT' as any, 8, TIME);

    expect(visit.status).toBe('REQUESTED');
    expect(writes).toHaveLength(2);
  });

  it.each(['CANCELLED', 'NO_SHOW'])('a visit that is %s and asked for again loses its old hour, its confirmation and the reason it ended (P3-01)', async (status) => {
    const { service, writes } = makeService({ status });

    await service.choosePreferredTime(CLIENT, 'CLIENT' as any, 8, TIME);

    const update = writes.find(([table]) => table === 'appointment')?.[1].update;

    expect(update).toMatchObject({ status: 'REQUESTED', startsAt: null, endsAt: null, confirmedAt: null, cancelledAt: null, cancelReason: null });
  });

  it.each(['COMPLETED', 'PAYMENT_PENDING', 'PAID', 'INVOICE_SENT', 'CANCELLED', 'DISPUTED'])('a job that is %s has no time to choose: 409, nothing is written', async (jobStatus) => {
    const { service, writes } = makeService({ jobStatus });
    const error = await failure(service.choosePreferredTime(CLIENT, 'CLIENT' as any, 8, TIME));

    expect(error.getStatus()).toBe(409);
    expect(writes).toHaveLength(0);
  });
});

describe('the visit of a job, as read through the service (P1-17)', () => {
  it('gives the customer the visit without the back office\'s note, the staff id, the reminders and the artisan\'s address', async () => {
    const { service } = makeService();
    const visit: any = await service.getAppointmentForIntervention(CLIENT, 'CLIENT' as any, 8);
    const text = JSON.stringify(visit);

    expect(visit.artisan).toEqual({ id: ARTISAN, name: 'Karim', phone: '20 222 222' });
    expect(text).not.toContain('NOTE-OF-THE-BACK-OFFICE');
    expect(text).not.toContain('REMINDER-ERROR');
    expect(text).not.toContain('karim@example.test');
    expect(visit).not.toHaveProperty('scheduledById');
  });

  it('gives the artisan the visit without the note, the staff id and the reminders', async () => {
    const { service } = makeService();
    const visit: any = await service.getAppointmentForIntervention(ARTISAN, 'ARTISAN' as any, 8);
    const text = JSON.stringify(visit);

    expect(visit.client.name).toBe('Sami');
    expect(text).not.toContain('NOTE-OF-THE-BACK-OFFICE');
    expect(text).not.toContain('REMINDER-ERROR');
    expect(visit).not.toHaveProperty('scheduledById');
  });

  it('gives the back office the row as it is', async () => {
    const { service } = makeService();
    const visit: any = await service.getAppointmentForIntervention(1, 'SUPPORT' as any, 8);

    expect(visit.adminNote).toBe('NOTE-OF-THE-BACK-OFFICE');
    expect(visit.scheduledById).toBe(77);
    expect(visit.reminders).toHaveLength(1);
  });

  it('refuses somebody who is not on the job', async () => {
    const { service } = makeService();
    const error = await failure(service.getAppointmentForIntervention(STRANGER, 'CLIENT' as any, 8));

    expect(error.getStatus()).toBe(403);
  });
});

describe('the accountant has no say over the visits (P1-17)', () => {
  const ACCOUNTANT = 'ACCOUNTANT' as any;

  it('cannot set the time, plan a visit, answer a request or confirm for the artisan: each moves the job, which is the ticket staff\'s', async () => {
    const { service, writes } = makeService();

    expect((await failure(service.choosePreferredTime(1, ACCOUNTANT, 8, TIME))).getStatus()).toBe(403);
    expect((await failure(service.scheduleIntervention(1, ACCOUNTANT, 8, { artisanId: ARTISAN, startsAt: '2026-11-03T09:00:00.000Z', endsAt: '2026-11-03T11:00:00.000Z' } as any))).getStatus()).toBe(403);
    expect((await failure(service.reviewAppointmentRequest(1, ACCOUNTANT, 5, true, {} as any))).getStatus()).toBe(403);
    expect((await failure(service.acceptScheduledMission(1, ACCOUNTANT, 3))).getStatus()).toBe(403);
    expect(writes).toHaveLength(0);
  });

  it('cannot read a visit either, and the roles that work on tickets still can', async () => {
    const { service } = makeService();

    expect((await failure(service.getAppointmentForIntervention(1, ACCOUNTANT, 8))).getStatus()).toBe(403);

    for (const role of ['ADMIN', 'SUPER_ADMIN', 'SUPPORT', 'DISPATCHER']) {
      expect(((await service.getAppointmentForIntervention(1, role as any, 8)) as any).adminNote).toBe('NOTE-OF-THE-BACK-OFFICE');
    }
  });
});
