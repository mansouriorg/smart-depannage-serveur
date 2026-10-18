import { BadRequestException, ConflictException } from '@nestjs/common';

import { AdminService } from './admin.service';

/** The dispatcher's status menu and cancellation, as the server receives them (P1-13). */

type Options = {
  clientPhone?: string | null;
  /** The live event cannot be sent. */
  liveThrows?: boolean;
  /** No text can be sent. */
  smsThrows?: boolean;
  /** The visit cannot be written (the database refuses). */
  visitThrows?: boolean;
};

function makeService(job: { status: string; artisanId: number | null }, visit: any = null, options: Options = {}) {
  const state: any = { ...job };
  const log: Array<{ table: string; op: string; args: any }> = [];
  const events: any[] = [];
  const live: any[] = [];
  const texts: Array<{ phone: string; text: string }> = [];
  const notices: any[] = [];
  /** Run once, between the moment the service reads the job and the moment it writes: somebody else's change. */
  const hooks: { beforeWrite?: () => void } = {};
  /** What the transaction in progress changed, so that it can be put back (and only that: not somebody else's change). */
  let undo: Array<[string, unknown, boolean]> = [];

  const record = (table: string, op: string, result?: any) => async (args: any) => {
    log.push({ table, op, args });
    return typeof result === 'function' ? result(args) : result;
  };

  const row = () => ({
    id: 12,
    ...state,
    client: { id: 3, name: 'Salma', phone: options.clientPhone === undefined ? '+21622123456' : options.clientPhone },
    artisan: state.artisanId ? { id: state.artisanId, name: 'Karim', phone: '+21655000111' } : null,
  });

  // What the client and the transaction each offer for the job. The update honours its WHERE like the
  // database: a row that is no longer in the status the service read matches nothing (P2025). Only what is
  // written through the transaction is undone when it fails: a write made through the client is committed.
  const jobTable = (throughTransaction: boolean) => ({
    findUnique: async (args: any) => {
      log.push({ table: 'intervention', op: 'findUnique', args });
      return row();
    },
    update: async (args: any) => {
      log.push({ table: 'intervention', op: 'update', args });

      const before = hooks.beforeWrite;
      hooks.beforeWrite = undefined;
      before?.();

      if (args.where.status !== undefined && args.where.status !== state.status) {
        throw Object.assign(new Error('Record to update not found.'), { code: 'P2025' });
      }

      if (throughTransaction) for (const key of Object.keys(args.data)) undo.push([key, state[key], key in state]);

      Object.assign(state, args.data);
      return row();
    },
  });

  // The visit and its reminders exist on the transaction only: a write made outside it would not find them.
  const tx: any = {
    intervention: jobTable(true),
    appointment: {
      findUnique: record('appointment', 'findUnique', visit),
      update: async (args: any) => {
        log.push({ table: 'appointment', op: 'update', args });

        if (options.visitThrows) throw new Error('database unavailable');

        return {};
      },
    },
    appointmentRequest: { updateMany: record('appointmentRequest', 'updateMany', { count: 0 }) },
    appointmentReminder: {
      deleteMany: record('appointmentReminder', 'deleteMany', {}),
      createMany: record('appointmentReminder', 'createMany', {}),
    },
  };

  // A transaction that is undone when its work fails, like the database's.
  const prisma: any = {
    intervention: jobTable(false),
    $transaction: async (work: (client: any) => Promise<unknown>) => {
      undo = [];

      try {
        return await work(tx);
      } catch (error) {
        for (const [key, value, existed] of undo.reverse()) {
          if (existed) state[key] = value;
          else delete state[key];
        }

        throw error;
      }
    },
  };

  const eventsService: any = { create: async (data: any) => events.push(data) };
  const notifications: any = {
    sendSms: async (phone: string, text: string) => {
      if (options.smsThrows) throw new Error('provider down');
      texts.push({ phone, text });
    },
    notify: async (payload: any) => {
      notices.push(payload);
    },
  };
  const realtime: any = {
    emitStatusChange: async (payload: any) => {
      if (options.liveThrows) throw new Error('socket closed');
      live.push(payload);
    },
  };

  return {
    service: new AdminService(prisma, notifications, eventsService, {} as any, {} as any, realtime),
    log,
    events,
    live,
    texts,
    notices,
    state,
    hooks,
    writesTo: (table: string) => log.filter((entry) => entry.table === table && entry.op !== 'findUnique'),
  };
}

/** The error a call ends with (the stand-in test runner cannot match a class in toThrow). */
async function failure(call: Promise<unknown>): Promise<any> {
  try {
    await call;
  } catch (error) {
    return error;
  }

  return null;
}

const visit = { id: 5, interventionId: 12, status: 'SCHEDULED', clientId: 3, artisanId: 7 };

describe('AdminService.changeInterventionStatus', () => {
  it('moves the job and writes the timeline line', async () => {
    const w = makeService({ status: 'ARTISAN_ACCEPTED', artisanId: 7 });

    await w.service.changeInterventionStatus(99, 12, { status: 'IN_PROGRESS' } as any);

    expect(w.writesTo('intervention').length).toBe(1);
    expect(w.state.status).toBe('IN_PROGRESS');
    expect(w.events.length).toBe(1);
  });

  it('tells the other screens: the live event names the old status, the new one and who made the change', async () => {
    const w = makeService({ status: 'ARTISAN_ACCEPTED', artisanId: 7 });

    await w.service.changeInterventionStatus(99, 12, { status: 'IN_PROGRESS' } as any);

    expect(w.live.length).toBe(1);
    expect(w.live[0].interventionId).toBe(12);
    expect(w.live[0].oldStatus).toBe('ARTISAN_ACCEPTED');
    expect(w.live[0].newStatus).toBe('IN_PROGRESS');
    expect(w.live[0].actorId).toBe(99);
  });

  it('the customer is texted when the technician is recorded as accepted, and when the job is completed (as the older route did), and not otherwise', async () => {
    const accepted = makeService({ status: 'ASSIGNED', artisanId: 7 });
    await accepted.service.changeInterventionStatus(99, 12, { status: 'ARTISAN_ACCEPTED' } as any);
    expect(accepted.texts.length).toBe(1);
    expect(accepted.texts[0].phone).toBe('+21622123456');
    expect(accepted.texts[0].text).toContain('Karim');
    expect(accepted.texts[0].text).toContain('acceptée');

    const done = makeService({ status: 'IN_PROGRESS', artisanId: 7 });
    await done.service.changeInterventionStatus(99, 12, { status: 'COMPLETED' } as any);
    expect(done.texts.length).toBe(1);
    expect(done.texts[0].text).toContain('terminée');

    const other = makeService({ status: 'ARTISAN_ACCEPTED', artisanId: 7 });
    await other.service.changeInterventionStatus(99, 12, { status: 'IN_PROGRESS' } as any);
    expect(other.texts.length).toBe(0);
  });

  it('no text when the customer has no phone, whichever text it would be', async () => {
    const done = makeService({ status: 'IN_PROGRESS', artisanId: 7 }, null, { clientPhone: null });
    await done.service.changeInterventionStatus(99, 12, { status: 'COMPLETED' } as any);
    expect(done.state.status).toBe('COMPLETED');
    expect(done.texts.length).toBe(0);

    const accepted = makeService({ status: 'ASSIGNED', artisanId: 7 }, null, { clientPhone: null });
    await accepted.service.changeInterventionStatus(99, 12, { status: 'ARTISAN_ACCEPTED' } as any);
    expect(accepted.state.status).not.toBe('ASSIGNED');
    expect(accepted.texts.length).toBe(0);
  });

  it('a live event or a text that fails does not undo the change, and the change is still answered', async () => {
    const live = makeService({ status: 'IN_PROGRESS', artisanId: 7 }, null, { liveThrows: true });
    const answer = await live.service.changeInterventionStatus(99, 12, { status: 'COMPLETED' } as any);
    expect(answer.status).toBe('COMPLETED');
    expect(live.state.status).toBe('COMPLETED');
    expect(live.texts.length).toBe(1);

    const sms = makeService({ status: 'IN_PROGRESS', artisanId: 7 }, null, { smsThrows: true });
    const second = await sms.service.changeInterventionStatus(99, 12, { status: 'COMPLETED' } as any);
    expect(second.status).toBe('COMPLETED');
    expect(sms.live.length).toBe(1);
  });

  it('a "change" to the status the job already has is silent: no timeline line, no live event, no text', async () => {
    const w = makeService({ status: 'IN_PROGRESS', artisanId: 7 });

    await w.service.changeInterventionStatus(99, 12, { status: 'IN_PROGRESS' } as any);

    expect(w.events.length).toBe(0);
    expect(w.live.length).toBe(0);
    expect(w.texts.length).toBe(0);
  });

  it('refuses to "assign" by status even where the table would allow it, and writes nothing', async () => {
    // A job that has a technician: IN_PROGRESS -> ASSIGNED is a move the table gives staff, so only the
    // guard stops it (for a job with nobody, the missing technician would stop it anyway).
    const w = makeService({ status: 'IN_PROGRESS', artisanId: 7 });

    const error = await failure(w.service.changeInterventionStatus(99, 12, { status: 'ASSIGNED' } as any));

    expect(error instanceof BadRequestException).toBe(true);
    expect(String(error.message)).toContain('assignation');
    expect(w.writesTo('intervention').length).toBe(0);
    expect(w.events.length).toBe(0);
  });

  it('refuses to "cancel" by status, where the table would allow it: the cancellation frees the visit and asks the reason', async () => {
    for (const status of ['CREATED', 'ARTISAN_ACCEPTED', 'IN_PROGRESS']) {
      const w = makeService({ status, artisanId: status === 'CREATED' ? null : 7 }, visit);

      const error = await failure(w.service.changeInterventionStatus(99, 12, { status: 'CANCELLED' } as any));

      expect(error instanceof BadRequestException).toBe(true);
      expect(String(error.message)).toContain('annulation');
      expect(w.writesTo('intervention').length).toBe(0);
      expect(w.writesTo('appointment').length).toBe(0);
      expect(w.live.length).toBe(0);
    }
  });

  it('stores the old name the apps read (ADMIN_REVIEW, ACCEPTED, ON_THE_WAY) while the storage is not canonical', async () => {
    const before = process.env.STATUS_STORAGE;
    delete process.env.STATUS_STORAGE;

    try {
      const a = makeService({ status: 'CREATED', artisanId: null });
      await a.service.changeInterventionStatus(99, 12, { status: 'WAITING_ADMIN_REVIEW' } as any);
      expect(a.state.status).toBe('ADMIN_REVIEW');

      const b = makeService({ status: 'ASSIGNED', artisanId: 7 });
      await b.service.changeInterventionStatus(99, 12, { status: 'ARTISAN_ACCEPTED' } as any);
      expect(b.state.status).toBe('ACCEPTED');

      const c = makeService({ status: 'ARTISAN_ACCEPTED', artisanId: 7 });
      await c.service.changeInterventionStatus(99, 12, { status: 'ARTISAN_ON_THE_WAY' } as any);
      expect(c.state.status).toBe('ON_THE_WAY');
    } finally {
      if (before === undefined) delete process.env.STATUS_STORAGE;
      else process.env.STATUS_STORAGE = before;
    }
  });

  it('writes nothing when the job is not in the status the screen showed (somebody moved it first)', async () => {
    const w = makeService({ status: 'ARTISAN_ON_THE_WAY', artisanId: 7 });

    expect((await failure(w.service.changeInterventionStatus(99, 12, { status: 'ARTISAN_ACCEPTED', expectedStatus: 'ASSIGNED' } as any))) instanceof ConflictException).toBe(true);

    expect(w.writesTo('intervention').length).toBe(0);
    expect(w.events.length).toBe(0);
    expect(w.live.length).toBe(0);
  });

  it('writes nothing when somebody moves the job between the moment it is read and the moment it is written', async () => {
    const w = makeService({ status: 'ARTISAN_ACCEPTED', artisanId: 7 });

    // The screen was right (the job is accepted), the server reads it so, and then a technician starts the job.
    w.hooks.beforeWrite = () => {
      w.state.status = 'IN_PROGRESS';
    };

    const error = await failure(w.service.changeInterventionStatus(99, 12, { status: 'ARTISAN_ON_THE_WAY', expectedStatus: 'ARTISAN_ACCEPTED' } as any));

    expect(error instanceof ConflictException).toBe(true);
    expect(String(error.message)).toContain('changé');
    expect(w.state.status).toBe('IN_PROGRESS');
    expect(w.events.length).toBe(0);
    expect(w.live.length).toBe(0);
  });

  it('the status the screen showed may be written in the old spelling', async () => {
    const w = makeService({ status: 'ACCEPTED', artisanId: 7 });

    await w.service.changeInterventionStatus(99, 12, { status: 'ARTISAN_ON_THE_WAY', expectedStatus: 'ARTISAN_ACCEPTED' } as any);

    expect(w.writesTo('intervention').length).toBe(1);
  });

  it('without the status the screen showed, the table alone decides (older callers)', async () => {
    const w = makeService({ status: 'ARTISAN_ON_THE_WAY', artisanId: 7 });

    await w.service.changeInterventionStatus(99, 12, { status: 'ARTISAN_ARRIVED' } as any);

    expect(w.state.status).toBe('ARRIVED');
  });

  it('still refuses a move the table does not allow', async () => {
    const w = makeService({ status: 'CANCELLED', artisanId: null });

    expect((await failure(w.service.changeInterventionStatus(99, 12, { status: 'IN_PROGRESS' } as any))) instanceof ConflictException).toBe(true);
    expect(w.writesTo('intervention').length).toBe(0);
    expect(w.live.length).toBe(0);
  });
});

describe('AdminService.cancelIntervention', () => {
  it('cancels the job and its booked visit together, and frees the technician\'s reminders', async () => {
    const w = makeService({ status: 'ARTISAN_ACCEPTED', artisanId: 7 }, visit);

    await w.service.cancelIntervention(99, 12, { reason: 'Le client ne répond plus.' } as any);

    expect(w.state.status).toBe('CANCELLED');
    expect(w.state.cancelledReason).toBe('Le client ne répond plus.');

    const appointment = w.writesTo('appointment');

    expect(appointment.length).toBe(1);
    expect(appointment[0].args.data.status).toBe('CANCELLED');
    expect(appointment[0].args.data.cancelReason).toBe('Le client ne répond plus.');
    expect(w.writesTo('appointmentReminder').length).toBe(1);
    expect(w.writesTo('appointmentRequest').length).toBe(1);
    expect(w.events.length).toBe(1);
  });

  it('the job and its visit are one transaction: if the visit cannot be written, the job stays as it was and nobody is told', async () => {
    const w = makeService({ status: 'ARTISAN_ACCEPTED', artisanId: 7 }, visit, { visitThrows: true });

    const error = await failure(w.service.cancelIntervention(99, 12, { reason: 'Le client ne répond plus.' } as any));

    expect(String(error.message)).toContain('database unavailable');
    expect(w.state.status).toBe('ARTISAN_ACCEPTED');
    expect(w.state.cancelledReason).toBe(undefined);
    expect(w.events.length).toBe(0);
    expect(w.live.length).toBe(0);
    expect(w.notices.length).toBe(0);
  });

  it('tells the other screens and the technician, with the reason', async () => {
    const w = makeService({ status: 'ARTISAN_ACCEPTED', artisanId: 7 }, visit);

    await w.service.cancelIntervention(99, 12, { reason: 'Le client ne répond plus.' } as any);

    expect(w.live.length).toBe(1);
    expect(w.live[0].newStatus).toBe('CANCELLED');
    expect(w.live[0].oldStatus).toBe('ARTISAN_ACCEPTED');
    expect(w.notices.length).toBe(1);
    expect(w.notices[0].recipientId).toBe(7);
    expect(w.notices[0].actorId).toBe(99);
    expect(w.notices[0].message).toContain('#12');
    expect(w.notices[0].message).toContain('Le client ne répond plus.');
    expect(w.notices[0].entityId).toBe(12);
  });

  it('a job with no technician has nobody to tell', async () => {
    const w = makeService({ status: 'WAITING_ADMIN_REVIEW', artisanId: null }, null);

    await w.service.cancelIntervention(99, 12, { reason: 'Doublon.' } as any);

    expect(w.live.length).toBe(1);
    expect(w.notices.length).toBe(0);
  });

  it('a notice or a live event that fails does not undo the cancellation', async () => {
    const w = makeService({ status: 'ARTISAN_ACCEPTED', artisanId: 7 }, visit, { liveThrows: true });

    const answer = await w.service.cancelIntervention(99, 12, { reason: 'Doublon.' } as any);

    expect(answer.status).toBe('CANCELLED');
    expect(w.state.status).toBe('CANCELLED');
    expect(w.notices.length).toBe(1);
  });

  it('a job with no visit is cancelled without touching any visit', async () => {
    const w = makeService({ status: 'WAITING_ADMIN_REVIEW', artisanId: null }, null);

    await w.service.cancelIntervention(99, 12, { reason: 'Doublon.' } as any);

    expect(w.state.status).toBe('CANCELLED');
    expect(w.writesTo('appointment').length).toBe(0);
  });

  it('a job that was already cancelled changes nothing, not even its visit, and tells nobody', async () => {
    const w = makeService({ status: 'CANCELLED', artisanId: 7 }, visit);

    await w.service.cancelIntervention(99, 12, { reason: 'Doublon.' } as any);

    expect(w.writesTo('appointment').length).toBe(0);
    expect(w.events.length).toBe(0);
    expect(w.live.length).toBe(0);
    expect(w.notices.length).toBe(0);
  });

  it('nothing is written when the job is not in the status the screen showed', async () => {
    const w = makeService({ status: 'IN_PROGRESS', artisanId: 7 }, visit);

    expect((await failure(w.service.cancelIntervention(99, 12, { reason: 'x', expectedStatus: 'ASSIGNED' } as any))) instanceof ConflictException).toBe(true);

    expect(w.state.status).toBe('IN_PROGRESS');
    expect(w.writesTo('appointment').length).toBe(0);
    expect(w.events.length).toBe(0);
    expect(w.live.length).toBe(0);
    expect(w.notices.length).toBe(0);
  });

  it('nothing is written when somebody moves the job between the moment it is read and the moment it is written', async () => {
    const w = makeService({ status: 'ARTISAN_ACCEPTED', artisanId: 7 }, visit);

    w.hooks.beforeWrite = () => {
      w.state.status = 'IN_PROGRESS';
    };

    expect((await failure(w.service.cancelIntervention(99, 12, { reason: 'x', expectedStatus: 'ARTISAN_ACCEPTED' } as any))) instanceof ConflictException).toBe(true);

    expect(w.state.status).toBe('IN_PROGRESS');
    expect(w.writesTo('appointment').length).toBe(0);
    expect(w.notices.length).toBe(0);
  });

  it('a move the table refuses leaves the visit alone', async () => {
    const w = makeService({ status: 'COMPLETED', artisanId: 7 }, visit);

    expect((await failure(w.service.cancelIntervention(99, 12, { reason: 'x' } as any))) instanceof ConflictException).toBe(true);

    expect(w.writesTo('appointment').length).toBe(0);
  });

  it('a blank reason is refused, with nothing written: the customer and the technician read it', async () => {
    for (const reason of ['', '   ', '\n\t', undefined]) {
      const w = makeService({ status: 'ARTISAN_ACCEPTED', artisanId: 7 }, visit);

      const error = await failure(w.service.cancelIntervention(99, 12, { reason } as any));

      expect(error instanceof BadRequestException).toBe(true);
      expect(String(error.message)).toContain('motif');
      expect(w.writesTo('intervention').length).toBe(0);
      expect(w.writesTo('appointment').length).toBe(0);
    }
  });

  it('the reason is kept without the spaces around it', async () => {
    const w = makeService({ status: 'ARTISAN_ACCEPTED', artisanId: 7 }, visit);

    await w.service.cancelIntervention(99, 12, { reason: '  Doublon.  ' } as any);

    expect(w.state.cancelledReason).toBe('Doublon.');
    expect(w.events[0].message).toBe('Doublon.');
    expect(w.writesTo('appointment')[0].args.data.cancelReason).toBe('Doublon.');
  });
});

describe('AdminService.findAllInterventions: page and limit that are not numbers', () => {
  function listService() {
    const calls: any[] = [];
    const prisma: any = {
      intervention: {
        findMany: async (args: any) => {
          calls.push(args);
          return [];
        },
        count: async () => 0,
      },
    };

    return { service: new AdminService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any), calls };
  }

  it('falls back to the first page of twenty instead of asking the database for NaN', async () => {
    for (const query of [{ page: 'abc', limit: 'x' }, { page: '1.5', limit: '2.5' }, { page: 'Infinity', limit: 'NaN' }]) {
      const w = listService();

      await w.service.findAllInterventions(query as any);

      expect(w.calls[0].skip).toBe(0);
      expect(w.calls[0].take).toBe(20);
    }
  });

  it('a number too large to be an exact whole number (1e21, 9007199254740993) is no page, and no limit', async () => {
    for (const big of ['1e21', '9007199254740993', '1e400']) {
      const w = listService();

      await w.service.findAllInterventions({ page: big, limit: big } as any);

      expect(w.calls[0].skip).toBe(0);
      expect(w.calls[0].take).toBe(20);
    }
  });

  it('a page past a million is the last page the list can be asked for: the offset stays one the database holds', async () => {
    const w = listService();

    await w.service.findAllInterventions({ page: '5000000', limit: '100' } as any);

    expect(w.calls[0].skip).toBe(999_999 * 100);
    expect(w.calls[0].skip).toBeLessThan(2_147_483_647);
  });

  it('keeps real numbers, within the limits', async () => {
    const w = listService();

    await w.service.findAllInterventions({ page: '3', limit: '500' } as any);

    expect(w.calls[0].skip).toBe(200);
    expect(w.calls[0].take).toBe(100);
  });
});
