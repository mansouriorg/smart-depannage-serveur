import { SchedulingService } from './scheduling.service';

/**
 * Who may set the time of a visit, and what the customer and the artisan read of it (P1-17). The route-level
 * check with two households is in src/common/testing/access/scheduling.ts; these are the plain cases.
 */

const CLIENT = 2;
const ARTISAN = 4;
const STRANGER = 9;

function makeService() {
  const job: any = {
    id: 8,
    clientId: CLIENT,
    artisanId: ARTISAN,
    client: { id: CLIENT, name: 'Sami', email: 'sami@example.test', phone: '20 111 111', role: 'CLIENT' },
    artisan: { id: ARTISAN, name: 'Karim', email: 'karim@example.test', phone: '20 222 222', role: 'ARTISAN' },
  };
  const row: any = {
    id: 3,
    interventionId: 8,
    clientId: CLIENT,
    artisanId: ARTISAN,
    status: 'SCHEDULED',
    adminNote: 'NOTE-OF-THE-BACK-OFFICE',
    scheduledById: 77,
    reminders: [{ id: 1, error: 'REMINDER-ERROR' }],
    requests: [],
    client: job.client,
    artisan: job.artisan,
  };
  const writes: any[] = [];
  const prisma: any = {
    intervention: {
      findUnique: async () => ({ ...job }),
      update: async (args: any) => {
        writes.push(['intervention', args]);

        return job;
      },
    },
    appointment: {
      findUnique: async () => ({ ...row }),
      upsert: async (args: any) => {
        writes.push(['appointment', args]);

        return { ...row, ...args.update };
      },
    },
  };

  return { service: new SchedulingService(prisma, {} as any, {} as any, {} as any), writes };
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
