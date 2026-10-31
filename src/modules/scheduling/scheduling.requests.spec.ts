import { ConflictException } from '@nestjs/common';

import { resetLocale } from '../../common/locale/locale';
import { isInternalEvent } from '../../common/views/views';
import { emptyWorld, World } from '../../common/testing/world';

import { lockJob } from '../assignment/artisan-lock';

import { SchedulingService } from './scheduling.service';
import { baseStatusOf, visitStatusFor } from './appointment-requests';

/**
 * Asking to move or cancel a visit, and the answer (P3-01), run on the real service and the in-memory database.
 *
 *  - a refusal puts the visit back to what it was (SCHEDULED, or CONFIRMED when the artisan had confirmed it), and shows a request
 *    that still waits;
 *  - nothing is asked about a visit that is over, or about a job that was done, cancelled or is in dispute;
 *  - an approved cancellation says who cancelled, and when the job holds money it says so to the back office.
 */

const at = (hour: number, day = 19) => new Date(Date.UTC(2099, 9, day, hour));
const MOVE = { requestedStartAt: at(14, 20).toISOString(), requestedEndAt: at(15, 20).toISOString(), reason: 'Empêchement' } as any;
const CANCEL = { reason: 'Plus besoin' } as any;

async function failure(work: () => Promise<unknown>): Promise<any> {
  try {
    await work();
  } catch (error) {
    return error;
  }

  throw new Error('expected a failure');
}

interface Desk {
  world: World;
  service: SchedulingService;
  admin: any;
  client: any;
  artisan: any;
  job: any;
  visit: any;
  told: { admins: any[]; refunds: any[]; users: any[] };
  stored: () => any;
  visitRow: () => any;
  requests: () => any[];
}

function desk(options: { jobStatus?: string; visit?: Record<string, any> | null; failNotices?: boolean } = {}): Desk {
  resetLocale();

  const world = emptyWorld();
  const m = world.memory;
  const admin = m.plant('user', { role: 'DISPATCHER', name: 'Dispatcher' });
  const client = m.plant('user', { role: 'CLIENT', name: 'Salma' });
  const artisan = m.plant('user', { role: 'ARTISAN', name: 'Karim' });

  m.plant('artisanProfile', { userId: artisan.id, verificationStatus: 'APPROVED', availabilityStatus: 'ONLINE', isAcceptingJobs: true, maxActiveJobs: 10, serviceTypes: ['PLOMBIER'] });

  const job = m.plant('intervention', { clientId: client.id, artisanId: artisan.id, status: options.jobStatus ?? 'ASSIGNED', serviceType: 'PLOMBIER' });
  const visit =
    options.visit === null
      ? null
      : m.plant('appointment', { interventionId: job.id, clientId: client.id, artisanId: artisan.id, status: 'SCHEDULED', startsAt: at(8), endsAt: at(10), ...(options.visit ?? {}) });

  const told = { admins: [] as any[], refunds: [] as any[], users: [] as any[] };
  const notifications: any = {
    notifyAdmins: async (payload: any) => told.admins.push(payload),
    notify: async (payload: any) => told.users.push(payload),
    notifyRefundDueAfterCancellation: async (...args: any[]) => {
      if (options.failNotices) throw new Error('the mail server is down');

      told.refunds.push(args);
    },
  };

  return {
    world,
    service: new SchedulingService(world.prisma, world.svc.assignment, notifications, undefined, world.svc.missionActions),
    admin,
    client,
    artisan,
    job,
    visit,
    told,
    stored: () => m.rows('intervention').find((row: any) => row.id === job.id),
    visitRow: () => m.rows('appointment').find((row: any) => row.interventionId === job.id),
    requests: () => m.rows('appointmentRequest'),
  };
}

const askMove = (d: Desk, userId = d.client.id, role = 'CLIENT') => d.service.requestReschedule(userId, role as any, d.visit.id, MOVE);
const askCancel = (d: Desk, userId = d.client.id, role = 'CLIENT') => d.service.requestCancel(userId, role as any, d.visit.id, CANCEL);
const answer = (d: Desk, requestId: number, approved: boolean) =>
  d.service.reviewAppointmentRequest(d.admin.id, 'DISPATCHER' as any, requestId, approved, { adminResponse: approved ? 'Ok' : 'Non' } as any);

describe('the rules that put a visit back', () => {
  it('a visit that is steady is what it is; one that shows a request is what the request kept', () => {
    expect(baseStatusOf({ status: 'SCHEDULED' })).toBe('SCHEDULED');
    expect(baseStatusOf({ status: 'CONFIRMED' }, [{ previousStatus: 'SCHEDULED' }])).toBe('CONFIRMED');
    expect(baseStatusOf({ status: 'CANCEL_REQUESTED' }, [{ previousStatus: 'CONFIRMED' }])).toBe('CONFIRMED');
    expect(baseStatusOf({ status: 'CANCEL_REQUESTED' }, [], { previousStatus: 'CONFIRMED' })).toBe('CONFIRMED');
  });

  it('a request made before the state was kept: confirmed when the artisan confirmed it, else planned', () => {
    expect(baseStatusOf({ status: 'RESCHEDULE_REQUESTED', confirmedAt: new Date() }, [{ previousStatus: null }])).toBe('CONFIRMED');
    expect(baseStatusOf({ status: 'RESCHEDULE_REQUESTED', confirmedAt: null }, [{ previousStatus: null }])).toBe('SCHEDULED');
    expect(baseStatusOf({ status: 'CANCEL_REQUESTED' })).toBe('SCHEDULED');
  });

  it('what is kept must be a steady state: a request that kept another state is not believed', () => {
    expect(baseStatusOf({ status: 'RESCHEDULE_REQUESTED', confirmedAt: null }, [{ previousStatus: 'CANCELLED' }])).toBe('SCHEDULED');
    expect(baseStatusOf({ status: 'RESCHEDULE_REQUESTED', confirmedAt: null }, [{ previousStatus: 'CANCEL_REQUESTED' }])).toBe('SCHEDULED');
  });

  it('a cancellation shows over a move, a move over nothing, and nothing shows what it was', () => {
    expect(visitStatusFor([{ type: 'RESCHEDULE' }, { type: 'CANCEL' }], 'CONFIRMED')).toBe('CANCEL_REQUESTED');
    expect(visitStatusFor([{ type: 'RESCHEDULE' }], 'CONFIRMED')).toBe('RESCHEDULE_REQUESTED');
    expect(visitStatusFor([], 'CONFIRMED')).toBe('CONFIRMED');
    expect(visitStatusFor([], 'SCHEDULED')).toBe('SCHEDULED');
  });
});

describe('asking to move or cancel a visit', () => {
  it('a request to move: the visit waits for an answer, the request keeps what the visit was, the back office is told', async () => {
    const d = desk({ visit: { status: 'CONFIRMED', confirmedAt: at(1) } });
    const request: any = await askMove(d);

    expect(d.visitRow().status).toBe('RESCHEDULE_REQUESTED');
    expect(d.requests()).toHaveLength(1);
    expect(d.requests()[0].previousStatus).toBe('CONFIRMED');
    expect(d.requests()[0].type).toBe('RESCHEDULE');
    expect(request.status).toBe('PENDING');
    expect(d.told.admins).toHaveLength(1);
  });

  it('a request to cancel: the same', async () => {
    const d = desk();

    await askCancel(d);

    expect(d.visitRow().status).toBe('CANCEL_REQUESTED');
    expect(d.requests()[0].previousStatus).toBe('SCHEDULED');
  });

  it('the artisan of the visit may ask too', async () => {
    const d = desk();

    await askMove(d, d.artisan.id, 'ARTISAN');

    expect(d.requests()[0].requestedById).toBe(d.artisan.id);
  });

  it('the previous state is not shown to the customer or the artisan (it is the back office\'s)', async () => {
    const d = desk();
    const request: any = await askMove(d);

    expect(request).not.toHaveProperty('previousStatus');
  });

  it('the same request twice while the first waits: 409, one request only (a double click is not a new wish)', async () => {
    const d = desk();

    await askMove(d);

    const error = await failure(() => askMove(d));

    expect(error instanceof ConflictException).toBe(true);
    expect(d.requests()).toHaveLength(1);
  });

  it('a cancellation may be asked while a move waits: the cancellation shows, and both remember the visit as it was', async () => {
    const d = desk({ visit: { status: 'CONFIRMED', confirmedAt: at(1) } });

    await askMove(d);
    await askCancel(d);

    expect(d.visitRow().status).toBe('CANCEL_REQUESTED');
    expect(d.requests().map((request) => request.previousStatus)).toEqual(['CONFIRMED', 'CONFIRMED']);
  });

  it('a move asked while a cancellation waits does not hide the cancellation', async () => {
    const d = desk();

    await askCancel(d);
    await askMove(d);

    expect(d.visitRow().status).toBe('CANCEL_REQUESTED');
  });

  it.each(['CANCELLED', 'COMPLETED', 'NO_SHOW', 'REQUESTED'])('a visit that is %s is not asked about: 409, nothing is written', async (status) => {
    for (const ask of [askMove, askCancel]) {
      const d = desk({ visit: { status } });
      const error = await failure(() => ask(d));

      expect(error instanceof ConflictException).toBe(true);
      expect(d.requests()).toHaveLength(0);
      expect(d.visitRow().status).toBe(status);
      expect(d.told.admins).toHaveLength(0);
    }
  });

  it.each(['COMPLETED', 'PAYMENT_PENDING', 'PAID', 'INVOICE_SENT', 'CANCELLED', 'DISPUTED'])('a job that is %s: the visit cannot be moved back or cancelled (409, nothing is written)', async (jobStatus) => {
    for (const ask of [askMove, askCancel]) {
      const d = desk({ jobStatus });
      const error = await failure(() => ask(d));

      expect(error instanceof ConflictException).toBe(true);
      expect(d.requests()).toHaveLength(0);
      expect(d.visitRow().status).toBe('SCHEDULED');
      expect(d.stored().status).toBe(jobStatus);
    }
  });

  it('a job that is stored under an old spelling of a finished status is finished all the same (INVOICE_READY is INVOICE_SENT)', async () => {
    for (const ask of [askMove, askCancel]) {
      const d = desk({ jobStatus: 'INVOICE_READY' });
      const error = await failure(() => ask(d));

      expect(error instanceof ConflictException).toBe(true);
      expect(d.requests()).toHaveLength(0);
      expect(d.visitRow().status).toBe('SCHEDULED');
    }
  });

  it('the job is read under its lock: a job that finished while the request waited for the lock is the one that counts', async () => {
    const d = desk();
    // What was read to check who may ask says "under way"; by the time the transaction starts the job is paid.
    const service = new SchedulingService(
      new Proxy(d.world.prisma, {
        get: (target, key) =>
          key === '$transaction'
            ? (work: any, options?: any) => {
                d.world.memory.rows('intervention')[0].status = 'PAID';

                return target.$transaction(work, options);
              }
            : target[key],
      }),
      d.world.svc.assignment,
      {} as any,
    );

    const error = await failure(() => service.requestCancel(d.client.id, 'CLIENT' as any, d.visit.id, CANCEL));

    expect(error instanceof ConflictException).toBe(true);
    expect(d.requests()).toHaveLength(0);
    expect(d.visitRow().status).toBe('SCHEDULED');
  });
});

describe('what is asked is checked again under the lock (P3-01)', () => {
  it('an artisan who gave the job back since the first look is no party of the visit any more: refused, nothing is written', async () => {
    const d = desk();
    const stale = { ...d.visitRow() };
    const other = d.world.memory.plant('user', { role: 'ARTISAN', name: 'Nabil' });

    d.visitRow().artisanId = other.id;
    (d.service as any).checkAppointmentAccess = async () => stale;

    const error = await failure(() => d.service.requestCancel(d.artisan.id, 'ARTISAN' as any, d.visit.id, CANCEL));

    expect(error.getStatus()).toBe(403);
    expect(d.requests()).toHaveLength(0);
    expect(d.visitRow().status).toBe('SCHEDULED');
    expect(d.told.admins).toHaveLength(0);
  });

  it('the back office is no party and needs none', async () => {
    const d = desk();
    const stale = { ...d.visitRow() };

    d.visitRow().artisanId = d.world.memory.plant('user', { role: 'ARTISAN', name: 'Nabil' }).id;
    (d.service as any).checkAppointmentAccess = async () => stale;

    await d.service.requestCancel(d.admin.id, 'DISPATCHER' as any, d.visit.id, CANCEL);

    expect(d.requests()).toHaveLength(1);
  });

  it('a visit nobody holds (the artisan gave the job back) cannot be asked about: 409, nothing is written, and it says to plan it again', async () => {
    for (const ask of [askMove, askCancel]) {
      const d = desk({ visit: { artisanId: null } });
      const error = await failure(() => ask(d));

      expect(error instanceof ConflictException).toBe(true);
      expect(error.message).toContain('n’a plus d’artisan');
      expect(d.requests()).toHaveLength(0);
      expect(d.visitRow().status).toBe('SCHEDULED');
      expect(d.told.admins).toHaveLength(0);
    }
  });

  it('two identical requests at the same moment: one is taken, the other is refused (the visit is read and written under the lock of the job)', async () => {
    const d = desk();
    const results = await Promise.allSettled([askMove(d), askMove(d)]);

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(d.requests()).toHaveLength(1);
    expect(d.visitRow().status).toBe('RESCHEDULE_REQUESTED');
  });

  it('a request waits for the lock of the job: nothing is read or written while another transaction holds it', async () => {
    const d = desk();
    let release!: () => void;
    let locked!: () => void;
    const open = new Promise<void>((resolve) => {
      release = resolve;
    });
    const taken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holding = d.world.prisma.$transaction(async (tx: any) => {
      await lockJob(tx, d.job.id);
      locked();
      await open;
    });

    await taken;

    const asking = askMove(d);

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(d.requests()).toHaveLength(0);

    release();
    await holding;
    await asking;

    expect(d.requests()).toHaveLength(1);
  });

  it('a visit nobody planned yet has nothing to move or cancel, and says so (not "no longer active")', async () => {
    const d = desk({ visit: { status: 'REQUESTED', startsAt: null, endsAt: null } });
    const error = await failure(() => askMove(d));

    expect(error.getStatus()).toBe(409);
    expect(error.message).toContain('Aucun horaire');
    expect(d.requests()).toHaveLength(0);
  });

  it('a visit that is over or cancelled says it is no longer active', async () => {
    for (const status of ['CANCELLED', 'COMPLETED', 'NO_SHOW']) {
      const d = desk({ visit: { status } });
      const error = await failure(() => askCancel(d));

      expect(error.getStatus()).toBe(409);
      expect(error.message).toContain('n’est plus actif');
    }
  });

  it('a request is made about the visit of the job it names, not about another', async () => {
    const d = desk();
    const error = await failure(() => (d.service as any).openRequest(d.client.id, 'CLIENT', d.job.id, d.visit.id + 100, { type: 'CANCEL', reason: 'x' }));

    expect(error.getStatus()).toBe(404);
    expect(d.requests()).toHaveLength(0);
    expect(d.visitRow().status).toBe('SCHEDULED');
  });
});

describe('a refused request puts the visit back', () => {
  it('a refused move: a planned visit is planned again', async () => {
    const d = desk();
    const request: any = await askMove(d);

    await answer(d, request.id, false);

    expect(d.visitRow().status).toBe('SCHEDULED');
    expect(d.requests()[0].status).toBe('REJECTED');
  });

  it('a refused move: a visit the artisan confirmed stays confirmed', async () => {
    const d = desk({ visit: { status: 'CONFIRMED', confirmedAt: at(1) } });
    const request: any = await askMove(d);

    await answer(d, request.id, false);

    expect(d.visitRow().status).toBe('CONFIRMED');
  });

  it('a refused cancellation: the same, for both states', async () => {
    for (const status of ['SCHEDULED', 'CONFIRMED']) {
      const d = desk({ visit: { status, confirmedAt: status === 'CONFIRMED' ? at(1) : null } });
      const request: any = await askCancel(d);

      expect(d.visitRow().status).toBe('CANCEL_REQUESTED');

      await answer(d, request.id, false);

      expect(d.visitRow().status).toBe(status);
    }
  });

  it('a request made before the state was kept (no previous status): confirmed if the artisan had confirmed, else planned', async () => {
    for (const [confirmedAt, expected] of [
      [at(1), 'CONFIRMED'],
      [null, 'SCHEDULED'],
    ] as const) {
      const d = desk({ visit: { status: 'RESCHEDULE_REQUESTED', confirmedAt } });
      const old = d.world.memory.plant('appointmentRequest', { appointmentId: d.visit.id, requestedById: d.client.id, type: 'RESCHEDULE', requestedStartAt: at(14, 20), requestedEndAt: at(15, 20) });

      await answer(d, old.id, false);

      expect(d.visitRow().status).toBe(expected);
    }
  });

  it('what the request kept decides, not the confirmation date: planned with a date of confirmation stays planned, confirmed with none stays confirmed', async () => {
    for (const [kept, confirmedAt] of [
      ['SCHEDULED', at(1)],
      ['CONFIRMED', null],
    ] as const) {
      const d = desk({ visit: { status: 'RESCHEDULE_REQUESTED', confirmedAt } });
      const old = d.world.memory.plant('appointmentRequest', { appointmentId: d.visit.id, requestedById: d.client.id, type: 'RESCHEDULE', previousStatus: kept, requestedStartAt: at(14, 20), requestedEndAt: at(15, 20) });

      await answer(d, old.id, false);

      expect(d.visitRow().status).toBe(kept);
    }
  });

  it('a request that still waits keeps showing: a refused cancellation leaves the move waiting, then the visit is what it was', async () => {
    const d = desk({ visit: { status: 'CONFIRMED', confirmedAt: at(1) } });
    const move: any = await askMove(d);
    const cancel: any = await askCancel(d);

    await answer(d, cancel.id, false);

    expect(d.visitRow().status).toBe('RESCHEDULE_REQUESTED');

    await answer(d, move.id, false);

    expect(d.visitRow().status).toBe('CONFIRMED');
  });

  it('a refused move while a cancellation waits leaves the cancellation showing', async () => {
    const d = desk();
    const move: any = await askMove(d);

    await askCancel(d);
    await answer(d, move.id, false);

    expect(d.visitRow().status).toBe('CANCEL_REQUESTED');
  });

  it('a visit that was cancelled meanwhile is not brought back to life by the refusal of a request about it', async () => {
    const d = desk();
    const request: any = await askMove(d);

    d.world.memory.rows('appointment')[0].status = 'CANCELLED';

    await answer(d, request.id, false);

    expect(d.visitRow().status).toBe('CANCELLED');
  });

  it('the refusal and the visit are written together: a refusal that fails leaves the request waiting and the visit as it was', async () => {
    const d = desk();
    const request: any = await askMove(d);
    // The write of the visit fails inside the transaction, after the request was marked refused.
    const before = JSON.stringify(d.world.memory.snapshot());
    const failing = d.world.memory.client();
    const service = new SchedulingService(
      new Proxy(failing, {
        get: (target, key) =>
          key === '$transaction'
            ? (work: any) =>
                target.$transaction((tx: any) =>
                  work(
                    new Proxy(tx, {
                      get: (inner, name) =>
                        name === 'appointment'
                          ? new Proxy(inner.appointment, { get: (appointments, method) => (method === 'update' ? async () => { throw new Error('the database went away'); } : appointments[method]) })
                          : inner[name],
                    }),
                  ),
                )
            : target[key],
      }),
      d.world.svc.assignment,
      {} as any,
    );

    const error = await failure(() => service.reviewAppointmentRequest(d.admin.id, 'DISPATCHER' as any, request.id, false, {} as any));

    expect(String(error.message)).toContain('database went away');
    expect(JSON.stringify(d.world.memory.snapshot())).toBe(before);
    expect(d.requests()[0].status).toBe('PENDING');
  });
});

describe('an approved move', () => {
  it('moves the visit and leaves it planned', async () => {
    const d = desk({ visit: { status: 'CONFIRMED', confirmedAt: at(1) } });
    const request: any = await askMove(d);

    await answer(d, request.id, true);

    expect(d.visitRow().status).toBe('SCHEDULED');
    expect(d.visitRow().startsAt).toEqual(at(14, 20));
  });

  it('a cancellation that was asked meanwhile keeps showing', async () => {
    const d = desk();
    const move: any = await askMove(d);

    await askCancel(d);
    await answer(d, move.id, true);

    expect(d.visitRow().status).toBe('CANCEL_REQUESTED');
    expect(d.visitRow().startsAt).toEqual(at(14, 20));
  });
});

describe('an answer needs a job that is still to be done (P3-01)', () => {
  it.each(['PAYMENT_PENDING', 'COMPLETED', 'PAID'])('a job that became %s while a request waited: approving it is refused (409), the visit and the job are left as they are', async (jobStatus) => {
    for (const ask of [askMove, askCancel]) {
      const d = desk();
      const request: any = await ask(d);
      const before = d.visitRow().status;

      d.stored().status = jobStatus;

      const error = await failure(() => answer(d, request.id, true));

      expect(error instanceof ConflictException).toBe(true);
      expect(d.stored().status).toBe(jobStatus);
      expect(d.visitRow().status).toBe(before);
      expect(d.visitRow().startsAt).toEqual(at(8));
      expect(d.requests()[0].status).toBe('PENDING');
    }
  });

  it('a job that is being worked on may still have its request answered', async () => {
    const d = desk();
    const request: any = await askMove(d);

    d.stored().status = 'IN_PROGRESS';
    await answer(d, request.id, true);

    expect(d.visitRow().startsAt).toEqual(at(14, 20));
  });
});

describe('an approved cancellation: who cancelled, and the money the job holds', () => {
  const payment = (d: Desk, data: Record<string, any>) =>
    d.world.memory.plant('payment', { interventionId: d.job.id, provider: 'MANUAL', method: 'BANK_TRANSFER', currency: 'TND', amountRefunded: 0, status: 'PAID', amount: 50, requestedAt: at(1), confirmedAt: at(1), ...data });

  it('writes who cancelled, when and why, on the job and on the visit', async () => {
    const d = desk();
    const request: any = await askCancel(d);

    await answer(d, request.id, true);

    const job = d.stored();

    expect(job.status).toBe('CANCELLED');
    expect(job.cancelledById).toBe(d.admin.id);
    expect(job.cancelledReason).toBe('Plus besoin');
    expect(job.cancelledAt instanceof Date).toBe(true);
    expect(d.visitRow().status).toBe('CANCELLED');
    expect(d.visitRow().cancelReason).toBe('Plus besoin');
  });

  it('puts a line in the job\'s timeline for everybody', async () => {
    const d = desk();
    const request: any = await askCancel(d);

    await answer(d, request.id, true);

    const lines = d.world.memory.rows('interventionEvent').filter((line: any) => line.interventionId === d.job.id);

    expect(lines).toHaveLength(1);
    expect(lines[0].type).toBe('CANCELLED');
    expect(lines[0].message).toBe('Plus besoin');
    expect(lines[0].createdById).toBe(d.admin.id);
    expect(isInternalEvent(lines[0])).toBe(false);
  });

  it('a job that holds no money: nothing to give back, nobody is told about money', async () => {
    const d = desk();

    payment(d, { status: 'PENDING' });
    payment(d, { status: 'FAILED' });
    payment(d, { amount: 20, currency: 'EUR' });

    const request: any = await askCancel(d);

    await answer(d, request.id, true);

    expect(d.told.refunds).toEqual([]);
    expect(d.world.memory.rows('interventionEvent').some((line: any) => line.type === 'INTERNAL_NOTE_ADDED')).toBe(false);
  });

  it('a job that holds money: a line for the back office with the amount, and the people who handle money are told', async () => {
    const d = desk();

    payment(d, { amount: 80, amountRefunded: 30, status: 'PARTIALLY_REFUNDED' });
    payment(d, { amount: 10, method: 'CASH' });

    const request: any = await askCancel(d);

    await answer(d, request.id, true);

    const note = d.world.memory.rows('interventionEvent').find((line: any) => line.type === 'INTERNAL_NOTE_ADDED');

    expect(note).toBeDefined();
    expect(note.title).toBe('Remboursement à décider');
    expect(note.message).toContain('60,000 TND');
    expect(note.metadata).toEqual({ internal: true, refundDue: 60 });
    expect(isInternalEvent(note)).toBe(true);
    expect(d.told.refunds).toEqual([[d.job.id, 60, d.admin.id]]);
  });

  it('a job whose money all went back holds nothing', async () => {
    const d = desk();

    payment(d, { amount: 40, amountRefunded: 40, status: 'REFUNDED' });

    const request: any = await askCancel(d);

    await answer(d, request.id, true);

    expect(d.told.refunds).toEqual([]);
  });

  it('a notice that cannot be sent does not undo the cancellation', async () => {
    const d = desk({ failNotices: true });

    payment(d, {});

    const request: any = await askCancel(d);

    await answer(d, request.id, true);

    expect(d.stored().status).toBe('CANCELLED');
    expect(d.requests()[0].status).toBe('APPROVED');
  });

  it('a job that cannot be cancelled any more leaves everything as it was (the guard comes before any write)', async () => {
    const d = desk();
    const request: any = await askCancel(d);

    // A payment is confirmed and the job completes before the answer: it is no longer under way.
    d.world.memory.rows('intervention')[0].status = 'COMPLETED';

    const before = JSON.stringify(d.world.memory.snapshot());
    const error = await failure(() => answer(d, request.id, true));

    expect(error instanceof ConflictException).toBe(true);
    expect(JSON.stringify(d.world.memory.snapshot())).toBe(before);
    expect(d.told.refunds).toEqual([]);
  });

  it('the cancellation, its lines and the visit are written together: a line that cannot be written undoes the cancellation, and nobody is told', async () => {
    const d = desk();

    payment(d, {});

    const request: any = await askCancel(d);
    const before = JSON.stringify(d.world.memory.snapshot());
    // The first line (the cancellation) is written, the second (the money) fails.
    d.world.memory.failNext('interventionEvent', 'create', new Error('the disk is full'), 1);

    const error = await failure(() => answer(d, request.id, true));

    expect(error.message).toBe('the disk is full');
    // The job was cancelled and the first line written before the second failed: all of it is undone.
    expect(JSON.stringify(d.world.memory.snapshot())).toBe(before);
    expect(d.stored().status).toBe('ASSIGNED');
    expect(d.told.refunds).toEqual([]);
  });

  describe('a standing invoice (the sum is the one of the refunds-due list)', () => {
    const invoice = (d: Desk, data: Record<string, any>) =>
      d.world.memory.plant('invoice', { interventionId: d.job.id, invoiceNumber: 'F-2026-0042', currency: 'TND', status: 'ISSUED', amountHT: 0, taxAmount: 0, amountTTC: 99, stampDuty: 1, creditedAmount: 0, issuedAt: at(1), ...data });
    const internalLines = (d: Desk) => d.world.memory.rows('interventionEvent').filter((line: any) => line.type === 'INTERNAL_NOTE_ADDED');

    it('the invoice still asks for part of what was paid: only the rest is to be given back, in the line and in the notice', async () => {
      const d = desk();

      payment(d, { amount: 100 });
      invoice(d, { amountTTC: 39, stampDuty: 1 });

      const request: any = await askCancel(d);

      await answer(d, request.id, true);

      const [note] = internalLines(d);

      expect(note.title).toBe('Remboursement à décider');
      // what the customer paid, and what is to be decided: not a claim that all of it is owed
      expect(note.message).toBe('La mission a été annulée alors que 100,000 TND du client sont encaissés: un remboursement de 60,000 TND est à décider.');
      expect(note.metadata).toEqual({ internal: true, refundDue: 60 });
      expect(d.told.refunds).toEqual([[d.job.id, 60, d.admin.id]]);
    });

    it('the invoice asks for all that was paid: nothing to give back, nobody told of a refund, and a line says the invoice stands', async () => {
      const d = desk();

      payment(d, { amount: 100 });
      invoice(d, {});

      const request: any = await askCancel(d);

      await answer(d, request.id, true);

      const lines = internalLines(d);

      expect(lines).toHaveLength(1);
      expect(lines[0].title).toBe('Facture à annuler ou à créditer');
      expect(lines[0].message).toContain('F-2026-0042');
      expect(lines[0].message).toContain('100,000 TND');
      expect(isInternalEvent(lines[0])).toBe(true);
      expect(d.told.refunds).toEqual([]);
    });

    it('an invoice that is marked paid still stands: the line does not call it open, it asks for it to be cancelled or credited', async () => {
      const d = desk();

      payment(d, { amount: 100 });
      invoice(d, { status: 'PAID' });

      const request: any = await askCancel(d);

      await answer(d, request.id, true);

      const lines = internalLines(d);

      expect(lines).toHaveLength(1);
      expect(lines[0].title).toBe('Facture à annuler ou à créditer');
      expect(lines[0].message).toBe('La mission a été annulée alors que la facture F-2026-0042 reste en vigueur et que le client a payé 100,000 TND: la facture est à annuler ou à créditer.');
      expect(lines[0].message).not.toContain('en cours');
    });

    it('the money and the invoices of another job are not counted', async () => {
      const d = desk();
      const other = d.world.memory.plant('intervention', { clientId: d.client.id, artisanId: d.artisan.id, status: 'PAID' });

      payment(d, { amount: 40 });
      d.world.memory.plant('payment', { interventionId: other.id, status: 'PAID', amount: 500, amountRefunded: 0, currency: 'TND' });
      d.world.memory.plant('invoice', { interventionId: other.id, invoiceNumber: 'F-2026-0099', currency: 'TND', status: 'ISSUED', amountHT: 0, taxAmount: 0, amountTTC: 500, stampDuty: 0, creditedAmount: 0, issuedAt: at(1) });

      const request: any = await askCancel(d);

      await answer(d, request.id, true);

      const [note] = internalLines(d);

      expect(note.title).toBe('Remboursement à décider');
      expect(note.metadata).toEqual({ internal: true, refundDue: 40 });
      expect(d.told.refunds).toEqual([[d.job.id, 40, d.admin.id]]);
    });

    it('an invoice that was cancelled, or is only a draft, asks nothing: all that was paid is to be decided', async () => {
      const d = desk();

      payment(d, { amount: 100 });
      invoice(d, { status: 'CANCELLED' });
      invoice(d, { status: 'DRAFT', invoiceNumber: 'F-2026-0043' });

      const request: any = await askCancel(d);

      await answer(d, request.id, true);

      expect(internalLines(d)[0].title).toBe('Remboursement à décider');
      expect(d.told.refunds).toEqual([[d.job.id, 100, d.admin.id]]);
    });

    it('an invoice in another currency cannot be set against the money of the company: no refund is worked out, the line says the invoice stands', async () => {
      const d = desk();

      payment(d, { amount: 100 });
      invoice(d, { currency: 'EUR' });

      const request: any = await askCancel(d);

      await answer(d, request.id, true);

      expect(internalLines(d)[0].title).toBe('Facture à annuler ou à créditer');
      expect(d.told.refunds).toEqual([]);
    });
  });
});

describe('scheduling cannot move a finished job back (P3-01)', () => {
  const schedule = (d: Desk) =>
    d.service.scheduleIntervention(d.admin.id, 'DISPATCHER' as any, d.job.id, { artisanId: d.artisan.id, startsAt: at(16, 21).toISOString(), endsAt: at(17, 21).toISOString() } as any);

  it.each(['COMPLETED', 'PAYMENT_PENDING', 'PAID', 'INVOICE_SENT', 'CANCELLED', 'DISPUTED'])('a job that is %s stays as it is, and no visit is written', async (jobStatus) => {
    const d = desk({ jobStatus, visit: null });
    const error = await failure(() => schedule(d));

    expect(error.getStatus()).toBe(409);
    expect(d.stored().status).toBe(jobStatus);
    expect(d.world.memory.rows('appointment')).toHaveLength(0);
  });

  it('a job that is paid and has a visit keeps both', async () => {
    const d = desk({ jobStatus: 'PAID', visit: { status: 'COMPLETED' } });
    const error = await failure(() => schedule(d));

    expect(error.getStatus()).toBe(409);
    expect(d.stored().status).toBe('PAID');
    expect(d.visitRow().status).toBe('COMPLETED');
    expect(d.visitRow().startsAt).toEqual(at(8));
  });
});
