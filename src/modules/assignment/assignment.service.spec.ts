import { FakeTable, withTransactions } from '../../common/testing/fake-tables';
import { AssignmentService, parseAssignmentRange } from './assignment.service';

const HOUR = 3600_000;
/**
 * 08:00 in Tunis (UTC+1 all year) on a Monday at least a week from now: a visit that is
 * booked already must still be in the future whenever the specs are run.
 */
function nextMonday8(): Date {
  const day = new Date(Date.now() + 7 * 24 * HOUR);
  day.setUTCHours(7, 0, 0, 0);

  while (day.getUTCDay() !== 1) day.setUTCDate(day.getUTCDate() + 1);

  return day;
}

const MONDAY_8 = nextMonday8();
const monday = (fromHour: number, toHour: number) => ({
  startsAt: new Date(MONDAY_8.getTime() + (fromHour - 8) * HOUR),
  endsAt: new Date(MONDAY_8.getTime() + (toHour - 8) * HOUR),
});

type Options = {
  notifyThrows?: boolean;
  eventsThrow?: boolean;
  liveThrows?: boolean;
  remindersThrow?: boolean;
  leaveThrows?: boolean;
  /** Called each time a lock is taken, with how many locks were taken so far: somebody else's change that lands just before it. */
  onLock?: (taken: number) => void;
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
  const interventions = new FakeTable({ defaults: () => ({ status: 'WAITING_ADMIN_REVIEW', artisanId: null, urgency: 'NORMAL', clientId: 1, assignedAt: null }) });
  const appointments = new FakeTable({ unique: ['interventionId'] });
  const blocks = new FakeTable();
  const reminders = new FakeTable();
  const requests = new FakeTable({ defaults: () => ({ status: 'PENDING', type: 'RESCHEDULE' }) });
  const offers = new FakeTable({ defaults: () => ({ status: 'PENDING', round: 1, rank: 1, expiresAt: new Date('2100-01-01T00:00:00Z') }) });

  const locks: number[][] = [];
  const lockSql: string[] = [];
  const prisma: any = withTransactions(
    {
      user: users,
      artisanProfile: profiles,
      intervention: interventions,
      appointment: appointments,
      artisanTimeBlock: blocks,
      appointmentReminder: reminders,
      appointmentRequest: requests,
      missionOffer: offers,
      $executeRaw: async (_strings: TemplateStringsArray, ...values: number[]) => {
        locks.push(values);
        lockSql.push(_strings.join('?'));
        options.onLock?.(lockSql.length);
        return 1;
      },
    },
    [users, profiles, interventions, appointments, blocks, reminders, requests, offers],
  );

  if (options.remindersThrow) {
    reminders.createMany = async () => {
      throw new Error('reminders down');
    };
  }

  const events: any[] = [];
  const notified: any[] = [];
  const others: any[] = [];
  const live: any[] = [];
  const left: Array<[number, number]> = [];
  const offerEvents: any[] = [];
  const order: string[] = [];

  const eventsService: any = {
    create: async (data: any) => {
      if (options.eventsThrow) throw new Error('timeline down');
      events.push(data);
    },
  };
  const notifications: any = {
    notifyArtisanAssigned: async (...args: any[]) => {
      if (options.notifyThrows) throw new Error('mail server down');
      notified.push(args);
    },
    notify: async (payload: any) => {
      if (options.notifyThrows) throw new Error('mail server down');
      others.push(payload);
    },
  };
  const realtime: any = {
    emitStatusChange: async (payload: any) => {
      if (options.liveThrows) throw new Error('socket down');
      live.push(payload);
      order.push('live');
    },
    emitOfferUpdate: (userId: number, payload: any) => {
      offerEvents.push([userId, payload]);
    },
    removeFromJobRoom: (userId: number, interventionId: number) => {
      if (options.leaveThrows) throw new Error('socket server down');
      left.push([userId, interventionId]);
      order.push('leave');
    },
  };

  const client = users.insert({ role: 'CLIENT', email: 'client@mail.tn' }); // id 1

  const addArtisan = (profile: Record<string, unknown> = {}, user: Record<string, unknown> = {}) => {
    const created = users.insert({ email: `artisan${users.rows.length}@mail.tn`, ...user });
    profiles.insert({ userId: created.id, ...profile });

    return created.id as number;
  };

  const addJob = (fields: Record<string, unknown> = {}) => interventions.insert({ clientId: client.id, address: 'Rue de Marseille, Tunis', ...fields }).id as number;

  return {
    users, profiles, interventions, appointments, blocks, reminders, requests, offers, offerEvents, locks, lockSql, events, notified, others, live, left, order,
    addArtisan, addJob,
    job: (id: number) => interventions.rows.find((row) => row.id === id)!,
    service: new AssignmentService(prisma, notifications, eventsService, realtime),
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

const assign = (w: World, interventionId: number, artisanId: number, extra: Record<string, unknown> = {}) =>
  w.service.assign({ interventionId, artisanId, actorId: 99, ...extra });

describe('parseAssignmentRange', () => {
  it('none, or both ends in order', () => {
    expect(parseAssignmentRange(undefined, undefined)).toBe(undefined);
    expect(parseAssignmentRange(null, '')).toBe(undefined);
    expect(parseAssignmentRange('2026-10-19T07:00:00Z', '2026-10-20T07:00:00Z')!.endsAt.getTime()).toBe(new Date('2026-10-20T07:00:00Z').getTime()); // a whole day is the longest
    expect(parseAssignmentRange('2026-10-19T07:00:00Z', '2026-10-19T09:00:00Z')!.endsAt.getTime()).toBe(new Date('2026-10-19T09:00:00Z').getTime());
  });

  it('a time with no "Z" and no offset is read on the clock of the business, not of the server', () => {
    const tunis = parseAssignmentRange('2026-10-19T09:00', '2026-10-19T10:30', 'Africa/Tunis')!;
    const paris = parseAssignmentRange('2026-10-19 09:00', '2026-10-19 10:30:30', 'Europe/Paris')!;

    expect(tunis.startsAt.toISOString()).toBe('2026-10-19T08:00:00.000Z');
    expect(tunis.endsAt.toISOString()).toBe('2026-10-19T09:30:00.000Z');
    expect(paris.startsAt.toISOString()).toBe('2026-10-19T07:00:00.000Z'); // Paris is UTC+2 on that day
    expect(paris.endsAt.toISOString()).toBe('2026-10-19T08:30:30.000Z');
  });

  it('a time with a "Z" or an offset is exact, whatever the clock of the business', () => {
    const exact = parseAssignmentRange('2026-10-19T09:00:00Z', '2026-10-19T11:00:00+01:00', 'Europe/Paris')!;

    expect(exact.startsAt.toISOString()).toBe('2026-10-19T09:00:00.000Z');
    expect(exact.endsAt.toISOString()).toBe('2026-10-19T10:00:00.000Z');
  });

  it('a date or a time that does not exist is a 400, not a guess: with or without an offset', () => {
    // Each start comes with the end that would make a one-hour visit if the start were
    // rolled over to the day the JavaScript parser would pick: the 400 can only come from the start.
    const status = (start: string, end: string, timeZone = 'Africa/Tunis') => {
      try {
        parseAssignmentRange(start, end, timeZone);
      } catch (error: any) {
        return error.getStatus();
      }

      return 0;
    };

    for (const [start, end] of [
      ['2026-13-05T09:00', '2027-01-05T10:00'], // no such month
      ['2026-10-19T25:00', '2026-10-19T10:00'], // no such hour
      ['2026-02-31T09:00', '2026-03-03T10:00'], // the parser would say the 3rd of March
      ['2026-02-29T09:00', '2026-03-01T10:00'], // 2026 is not a leap year
      ['2026-04-31T09:00', '2026-05-01T10:00'],
      ['2026-02-31T09:00:00Z', '2026-03-03T10:00:00Z'],
      ['2026-02-30T09:00:00+01:00', '2026-03-02T10:00:00+01:00'],
      ['2026-10-19T24:00', '2026-10-20T01:00'], // 24:00 would be the next day at 00:00
      ['2026-10-19T09:00:75', '2026-10-19T10:00'], // no such second
    ]) {
      expect([start, status(start, end)]).toEqual([start, 400]);
    }

    expect(status('2026-03-29T02:30', '2026-03-29T04:30', 'Europe/Paris')).toBe(400); // the hour the clocks skip (the end is later than where the start would land)
  });

  it('and the dates that do exist are kept: a leap day, the last day of a month, the hour after the clocks move', () => {
    const at = (start: string, end: string, timeZone = 'Africa/Tunis') => parseAssignmentRange(start, end, timeZone)!.startsAt.toISOString();

    expect(at('2028-02-29T09:00', '2028-02-29T10:00')).toBe('2028-02-29T08:00:00.000Z');
    expect(at('2026-04-30T23:30', '2026-05-01T00:30')).toBe('2026-04-30T22:30:00.000Z');
    expect(at('2026-03-29T03:30', '2026-03-29T04:30', 'Europe/Paris')).toBe('2026-03-29T01:30:00.000Z');
    expect(at('2026-02-28T09:00:00Z', '2026-02-28T10:00:00Z')).toBe('2026-02-28T09:00:00.000Z');
  });

  it('one end alone, an end before the start, a day and more, a date that is not one: 400', () => {
    for (const [a, b] of [
      ['2026-10-19T07:00:00Z', undefined],
      [undefined, '2026-10-19T07:00:00Z'],
      ['2026-10-19T09:00:00Z', '2026-10-19T07:00:00Z'],
      ['2026-10-19T09:00:00Z', '2026-10-19T09:00:00Z'],
      ['2026-10-19T07:00:00Z', '2026-10-20T07:00:01Z'],
      ['soon', 'later'],
    ]) {
      let status = 0;

      try {
        parseAssignmentRange(a, b);
      } catch (error: any) {
        status = error.getStatus();
      }

      expect(status).toBe(400);
    }
  });
});

describe('giving a job to an artisan (P1-05)', () => {
  it('an approved, free artisan gets a job that is waiting: status, artisan, date, timeline, notification, live event', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const id = w.addJob();

    const result = await assign(w, id, artisan);

    expect(w.job(id).status).toBe('ASSIGNED');
    expect(w.job(id).artisanId).toBe(artisan);
    expect(w.job(id).assignedAt instanceof Date).toBe(true);
    expect(result.appointment).toBe(null);
    expect(w.events.length).toBe(1);
    expect(w.events[0].type).toBe('ARTISAN_ASSIGNED');
    expect(w.events[0].createdById).toBe(99);
    expect(w.notified.length).toBe(1);
    expect(w.notified[0].slice(0, 3)).toEqual([id, artisan, 99]);
    expect(w.notified[0][3]).toBe(undefined);
    expect(w.live.length).toBe(1);
    expect(w.live[0].newStatus).toBe('ASSIGNED');
    expect(w.live[0].oldStatus).toBe('WAITING_ADMIN_REVIEW');
  });

  it('the job and the artisan are locked, in that order, inside the transaction', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const id = w.addJob();

    await assign(w, id, artisan);

    expect(w.locks).toEqual([[71001, id], [71002, artisan]]);
  });

  describe('who may be given a job', () => {
    it('an artisan whose application is not approved is refused, whatever the reason, and nothing moves', async () => {
      for (const verificationStatus of ['DRAFT', 'PENDING_REVIEW', 'REJECTED', 'SUSPENDED']) {
        const w = makeWorld();
        const artisan = w.addArtisan({ verificationStatus });
        const id = w.addJob();

        const error = await failure(assign(w, id, artisan));

        expect(error.getStatus()).toBe(400);
        expect(w.job(id).status).toBe('WAITING_ADMIN_REVIEW');
        expect(w.job(id).artisanId).toBe(null);
        expect(w.events.length + w.notified.length + w.live.length).toBe(0);
      }
    });

    it('a disabled or deleted account is refused', async () => {
      const w = makeWorld();
      const off = w.addArtisan({}, { isActive: false });
      const gone = w.addArtisan({}, { deletedAt: new Date() });
      const id = w.addJob();

      expect((await failure(assign(w, id, off))).getStatus()).toBe(400);
      expect((await failure(assign(w, id, gone))).getStatus()).toBe(400);
      expect(w.job(id).artisanId).toBe(null);
    });

    it('somebody who is not an artisan, a number nobody has, an artisan with no profile: 404', async () => {
      const w = makeWorld();
      const id = w.addJob();
      const noProfile = w.users.insert({ email: 'x@mail.tn' }).id;

      expect((await failure(assign(w, id, 1))).getStatus()).toBe(404); // the client
      expect((await failure(assign(w, id, 4242))).getStatus()).toBe(404);
      expect((await failure(assign(w, id, noProfile))).getStatus()).toBe(404);
      expect(w.job(id).artisanId).toBe(null);
    });

    it('a job that does not exist: 404', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan();

      expect((await failure(assign(w, 777, artisan))).getStatus()).toBe(404);
    });
  });

  describe('what state the job may be in', () => {
    it('a finished, cancelled or disputed job cannot be given to an artisan: 409, nothing changes', async () => {
      for (const status of ['COMPLETED', 'CANCELLED', 'DISPUTED', 'PAYMENT_PENDING']) {
        const w = makeWorld();
        const artisan = w.addArtisan();
        const id = w.addJob({ status, artisanId: null });

        const error = await failure(assign(w, id, artisan));

        expect(error.getStatus()).toBe(409);
        expect(w.job(id).status).toBe(status);
        expect(w.job(id).artisanId).toBe(null);
        expect(w.notified.length + w.events.length).toBe(0);
      }
    });

    it('a job that is already running can be handed to another artisan (the status table allows it)', async () => {
      const w = makeWorld();
      const first = w.addArtisan();
      const second = w.addArtisan();
      const id = w.addJob({ status: 'IN_PROGRESS', artisanId: first });

      await assign(w, id, second);

      expect(w.job(id).status).toBe('ASSIGNED');
      expect(w.job(id).artisanId).toBe(second);
    });
  });

  describe('whether the artisan is free', () => {
    const refusals: Array<[string, Record<string, unknown>]> = [
      ['does not take missions', { isAcceptingJobs: false }],
      ['is not available for emergencies (when the job is one)', { emergencyAvailable: false }],
    ];

    for (const [label, profile] of refusals) it(`an artisan who ${label} is refused with the reasons, and the job stays as it was`, async () => {
      const w = makeWorld();
      const artisan = w.addArtisan(profile);
      const id = w.addJob({ urgency: 'EMERGENCY' });

      const error = await failure(assign(w, id, artisan));

      expect(error.getStatus()).toBe(400);
      expect(error.getResponse().issues.length).toBe(1);
      expect(w.job(id).status).toBe('WAITING_ADMIN_REVIEW');
      expect(w.job(id).artisanId).toBe(null);
      expect(w.events.length + w.notified.length + w.live.length).toBe(0);
    });

    it('an artisan who is not available for emergencies can still take an ordinary job', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan({ emergencyAvailable: false });
      const id = w.addJob({ urgency: 'NORMAL' });

      await assign(w, id, artisan);

      expect(w.job(id).artisanId).toBe(artisan);
    });

    it('an artisan at the maximum of active missions is refused; a finished mission does not count', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan({ maxActiveJobs: 2 });
      w.addJob({ status: 'ARTISAN_ACCEPTED', artisanId: artisan });
      w.addJob({ status: 'IN_PROGRESS', artisanId: artisan });
      w.addJob({ status: 'COMPLETED', artisanId: artisan });
      const id = w.addJob();

      const error = await failure(assign(w, id, artisan));

      expect(error.getStatus()).toBe(400);
      expect(error.getResponse().issues).toEqual(['Artisan au maximum de missions actives.']);

      // one of the two active missions ends: the artisan is free again
      w.interventions.rows.find((row) => row.status === 'IN_PROGRESS')!.status = 'COMPLETED';
      await assign(w, id, artisan);
      expect(w.job(id).artisanId).toBe(artisan);
    });
  });

  describe('with a time', () => {
    it('writes the appointment in the business time zone, with its reminders, and says the time in the messages', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const id = w.addJob();
      const start = new Date(Date.now() + 72 * HOUR);
      const end = new Date(start.getTime() + 2 * HOUR);

      const result = await assign(w, id, artisan, { startsAt: start, endsAt: end, adminNote: 'Code portail 1234' });

      expect(result.appointment.status).toBe('SCHEDULED');
      expect(result.appointment.artisanId).toBe(artisan);
      expect(result.appointment.clientId).toBe(1);
      expect(result.appointment.scheduledById).toBe(99);
      expect(result.appointment.adminNote).toBe('Code portail 1234');
      expect(result.appointment.timezone).toBe('Africa/Tunis');
      expect(w.reminders.rows.length).toBe(4);
      expect(w.notified[0][3].when.includes(' à ')).toBe(true);
      expect(w.events[0].message.includes('rendez-vous le')).toBe(true);
    });

    it('another job of the artisan over the same hours: refused, and the job and the appointment are not written', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const other = w.addJob({ status: 'ASSIGNED', artisanId: artisan });
      w.appointments.insert({ interventionId: other, clientId: 1, artisanId: artisan, status: 'SCHEDULED', ...monday(9, 11) });
      const id = w.addJob();

      const error = await failure(assign(w, id, artisan, monday(10, 12)));

      expect(error.getStatus()).toBe(400);
      expect(error.getResponse().issues).toEqual(['Artisan déjà réservé sur ce créneau.']);
      expect(w.job(id).artisanId).toBe(null);
      expect(w.job(id).status).toBe('WAITING_ADMIN_REVIEW');
      expect(w.appointments.rows.length).toBe(1);
    });

    it('back to back is fine: one visit ending when the next begins', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const other = w.addJob({ status: 'ASSIGNED', artisanId: artisan });
      w.appointments.insert({ interventionId: other, clientId: 1, artisanId: artisan, status: 'SCHEDULED', ...monday(9, 11) });
      const id = w.addJob();

      await assign(w, id, artisan, monday(11, 12));

      expect(w.job(id).artisanId).toBe(artisan);
    });

    it('a cancelled or finished appointment does not hold the artisan', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan();
      for (const status of ['CANCELLED', 'COMPLETED', 'NO_SHOW']) {
        const old = w.addJob({ status: 'COMPLETED', artisanId: artisan });
        w.appointments.insert({ interventionId: old, clientId: 1, artisanId: artisan, status, ...monday(9, 11) });
      }
      const id = w.addJob();

      await assign(w, id, artisan, monday(9, 11));

      expect(w.job(id).artisanId).toBe(artisan);
    });

    it('a block of unavailable time over the visit: refused', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan();
      w.blocks.insert({ artisanId: artisan, type: 'VACATION', ...monday(0, 23) });
      const id = w.addJob();

      const error = await failure(assign(w, id, artisan, monday(9, 10)));

      expect(error.getResponse().issues).toEqual(['Artisan indisponible sur ce créneau.']);
      expect(w.job(id).artisanId).toBe(null);
    });

    it('the weekly schedule is the one of the business: Monday to Friday 08:00-17:00 in Tunis', async () => {
      const w = makeWorld();
      const availability = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'].map((dayOfWeek) => ({ dayOfWeek, startTime: '08:00', endTime: '17:00', isAvailable: true }));
      const artisan = w.addArtisan({ availability });
      const sunday = { startsAt: new Date('2026-10-18T09:00:00Z'), endsAt: new Date('2026-10-18T10:00:00Z') };

      expect((await failure(assign(w, w.addJob(), artisan, sunday))).getResponse().issues).toEqual(['Pas disponible sur ce créneau hebdomadaire.']);
      expect((await failure(assign(w, w.addJob(), artisan, { startsAt: new Date('2026-10-19T06:30:00Z'), endsAt: new Date('2026-10-19T08:00:00Z') }))).getStatus()).toBe(400); // 07:30 in Tunis
      const ok = w.addJob();
      await assign(w, ok, artisan, monday(8, 9));
      expect(w.job(ok).artisanId).toBe(artisan);
    });

    it('an artisan with no weekly schedule at all is not restricted by it', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan({ availability: [] });
      const id = w.addJob();

      await assign(w, id, artisan, { startsAt: new Date('2026-10-18T02:00:00Z'), endsAt: new Date('2026-10-18T03:00:00Z') });

      expect(w.job(id).artisanId).toBe(artisan);
    });

    it('a time that is not a time is a 400 before anything is looked at', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const id = w.addJob();

      expect((await failure(assign(w, id, artisan, { startsAt: 'soon', endsAt: 'later' }))).getStatus()).toBe(400);
      expect((await failure(assign(w, id, artisan, { startsAt: MONDAY_8 }))).getStatus()).toBe(400);
      expect(w.locks.length).toBe(0);
    });
  });

  describe('a job that already has an appointment', () => {
    it('given to another artisan without a new time: the new artisan must be free at the booked time, and the appointment moves to them', async () => {
      const w = makeWorld();
      const first = w.addArtisan();
      const second = w.addArtisan();
      const id = w.addJob({ status: 'ASSIGNED', artisanId: first });
      w.appointments.insert({ interventionId: id, clientId: 1, artisanId: first, status: 'SCHEDULED', ...monday(9, 11) });
      const busy = w.addJob({ status: 'ASSIGNED', artisanId: second });
      w.appointments.insert({ interventionId: busy, clientId: 1, artisanId: second, status: 'SCHEDULED', ...monday(10, 12) });

      expect((await failure(assign(w, id, second))).getResponse().issues).toEqual(['Artisan déjà réservé sur ce créneau.']);
      expect(w.appointments.rows.find((row) => row.interventionId === id)!.artisanId).toBe(first);

      w.appointments.rows.find((row) => row.interventionId === busy)!.status = 'CANCELLED';
      await assign(w, id, second);

      expect(w.job(id).artisanId).toBe(second);
      expect(w.appointments.rows.find((row) => row.interventionId === id)!.artisanId).toBe(second);
      expect(w.appointments.rows.find((row) => row.interventionId === id)!.status).toBe('SCHEDULED');
    });

    it('the reminders of the artisan who lost the job go away, the ones already sent stay', async () => {
      const w = makeWorld();
      const first = w.addArtisan();
      const second = w.addArtisan();
      const id = w.addJob({ status: 'ASSIGNED', artisanId: first });
      const start = new Date(Date.now() + 72 * HOUR);
      const appointment = w.appointments.insert({ interventionId: id, clientId: 1, artisanId: first, status: 'SCHEDULED', startsAt: start, endsAt: new Date(start.getTime() + HOUR) });
      w.reminders.insert({ appointmentId: appointment.id, recipientId: first, status: 'PENDING', minutesBefore: 120 });
      w.reminders.insert({ appointmentId: appointment.id, recipientId: first, status: 'SENT', minutesBefore: 1440 });

      await assign(w, id, second);

      expect(w.reminders.rows.filter((r) => r.recipientId === first && r.status === 'PENDING').length).toBe(0);
      expect(w.reminders.rows.filter((r) => r.recipientId === first && r.status === 'SENT').length).toBe(1);
      expect(w.reminders.rows.filter((r) => r.recipientId === second).length).toBe(2);
    });

    it('its own appointment does not make the artisan "busy" when the same job is given a new time', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const id = w.addJob({ status: 'ARTISAN_ACCEPTED', artisanId: artisan });
      w.appointments.insert({ interventionId: id, clientId: 1, artisanId: artisan, status: 'CONFIRMED', ...monday(9, 11) });

      await assign(w, id, artisan, { ...monday(10, 12), adminNote: 'Reporté' });

      const row = w.appointments.rows[0];
      expect(row.startsAt.getTime()).toBe(monday(10, 12).startsAt.getTime());
      expect(row.status).toBe('SCHEDULED');
      expect(row.adminNote).toBe('Reporté');
      expect(w.job(id).status).toBe('ARTISAN_ACCEPTED'); // the artisan who accepted does not have to accept again
      expect(w.notified.length).toBe(0);
      expect(w.others.map((o) => o.title)).toEqual(['Rendez-vous modifié', 'Rendez-vous modifié']);
      expect(w.events[0].title).toBe('Rendez-vous modifié');
    });

    it('a new time keeps the admin note when none is given', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const id = w.addJob({ status: 'ASSIGNED', artisanId: artisan });
      w.appointments.insert({ interventionId: id, clientId: 1, artisanId: artisan, status: 'SCHEDULED', adminNote: 'Sonner deux fois', ...monday(9, 11) });

      await assign(w, id, artisan, monday(13, 14));

      expect(w.appointments.rows[0].adminNote).toBe('Sonner deux fois');
    });
  });

  describe('handing a job from one artisan to another', () => {
    it('the first is told the mission is withdrawn, the second is told it is theirs, the timeline says the artisan changed', async () => {
      const w = makeWorld();
      const first = w.addArtisan();
      const second = w.addArtisan();
      const id = w.addJob({ status: 'ASSIGNED', artisanId: first });

      await assign(w, id, second);

      expect(w.job(id).artisanId).toBe(second);
      expect(w.notified.map((n) => n[1])).toEqual([second]);
      expect(w.others.length).toBe(1);
      expect(w.others[0].recipientId).toBe(first);
      expect(w.others[0].title).toBe('Mission retirée');
      expect(w.events[0].title).toBe('Artisan changé');
      expect(w.events[0].metadata.previousArtisanId).toBe(first);
    });

    it('the first stops hearing about the job: they leave its live room before the live event goes out', async () => {
      const w = makeWorld();
      const first = w.addArtisan();
      const second = w.addArtisan();
      const id = w.addJob({ status: 'ASSIGNED', artisanId: first });

      await assign(w, id, second);

      expect(w.left).toEqual([[first, id]]);
      expect(w.order).toEqual(['leave', 'live']);
    });

    it('nobody leaves when the job was free, when the same artisan is given another time, or when it changes nothing', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const free = w.addJob({ status: 'ADMIN_REVIEW', artisanId: null });
      const theirs = w.addJob({ status: 'ASSIGNED', artisanId: artisan });
      const start = new Date(Date.now() + 5 * 24 * 3600_000);

      await assign(w, free, artisan);
      await assign(w, theirs, artisan, { startsAt: start, endsAt: new Date(start.getTime() + 3600_000) });
      await assign(w, theirs, artisan);

      expect(w.left).toEqual([]);
    });

    it('a socket server that is down does not undo the hand-over, and the live event still goes out', async () => {
      const w = makeWorld({ leaveThrows: true });
      const first = w.addArtisan();
      const second = w.addArtisan();
      const id = w.addJob({ status: 'ASSIGNED', artisanId: first });

      await assign(w, id, second);

      expect(w.job(id).artisanId).toBe(second);
      expect(w.live).toHaveLength(1);
      expect(w.others).toHaveLength(1);
    });
  });

  describe('who the screen showed as holding the job (expectedArtisanId)', () => {
    it('a job nobody holds, still free: the assignment goes through', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const id = w.addJob();

      await assign(w, id, artisan, { expectedArtisanId: null });

      expect(w.job(id).artisanId).toBe(artisan);
    });

    it('a job the screen showed as free, that somebody else has been given meanwhile, is a 409 and nothing is written or said', async () => {
      const w = makeWorld();
      const first = w.addArtisan();
      const second = w.addArtisan();
      const id = w.addJob({ status: 'ASSIGNED', artisanId: first });

      const error = await failure(assign(w, id, second, { expectedArtisanId: null }));

      expect(error.getStatus()).toBe(409);
      expect(String(error.message)).toContain('autre technicien');
      expect(w.job(id).artisanId).toBe(first);
      expect(w.events.length + w.notified.length + w.others.length + w.live.length).toBe(0);
      expect(w.left.length).toBe(0);
    });

    it('a job the screen showed with one technician, who has been replaced meanwhile by a third, is a 409', async () => {
      const w = makeWorld();
      const shown = w.addArtisan();
      const now = w.addArtisan();
      const chosen = w.addArtisan();
      const id = w.addJob({ status: 'ASSIGNED', artisanId: now });

      const error = await failure(assign(w, id, chosen, { expectedArtisanId: shown }));

      expect(error.getStatus()).toBe(409);
      expect(w.job(id).artisanId).toBe(now);
    });

    it('the technician the screen showed is still the one: the job is handed over', async () => {
      const w = makeWorld();
      const shown = w.addArtisan();
      const chosen = w.addArtisan();
      const id = w.addJob({ status: 'ASSIGNED', artisanId: shown });

      await assign(w, id, chosen, { expectedArtisanId: shown });

      expect(w.job(id).artisanId).toBe(chosen);
      expect(w.left).toEqual([[shown, id]]);
    });

    it('giving the job to the one who has it by now is the same wish twice, not a conflict (a double click, two people agreeing)', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const id = w.addJob({ status: 'ASSIGNED', artisanId: artisan });

      const result = await assign(w, id, artisan, { expectedArtisanId: null });

      expect(result.intervention.artisanId).toBe(artisan);
      expect(w.notified.length + w.others.length + w.events.length + w.live.length).toBe(0);
    });

    it('without it nothing is checked (the callers that never knew who held the job)', async () => {
      const w = makeWorld();
      const first = w.addArtisan();
      const second = w.addArtisan();
      const id = w.addJob({ status: 'ASSIGNED', artisanId: first });

      await assign(w, id, second);

      expect(w.job(id).artisanId).toBe(second);
    });
  });

  describe('the same artisan again', () => {
    it('with no new time nothing happens: no message, no timeline line, and a job the artisan accepted stays accepted', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const id = w.addJob({ status: 'ARTISAN_ACCEPTED', artisanId: artisan });

      const result = await assign(w, id, artisan);

      expect(result.intervention.status).toBe('ARTISAN_ACCEPTED');
      expect(w.job(id).status).toBe('ARTISAN_ACCEPTED');
      expect(w.notified.length + w.others.length + w.events.length + w.live.length).toBe(0);
    });

    it('a new time for an artisan who has just given the job back is a 409 and books nothing', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const id = w.addJob({ status: 'ASSIGNED', artisanId: artisan });
      // the artisan declines through a route that takes none of our locks, between our read and our write
      const findUnique = w.interventions.findUnique.bind(w.interventions);
      let reads = 0;
      w.interventions.findUnique = async (args: any) => {
        const found = await findUnique(args);

        if (++reads === 1) Object.assign(w.interventions.rows[0], { status: 'WAITING_ADMIN_REVIEW', artisanId: null });

        return found;
      };

      const error = await failure(assign(w, id, artisan, monday(9, 10)));

      expect(error.getStatus()).toBe(409);
      expect(w.appointments.rows.length).toBe(0);
      expect(w.events.length + w.notified.length + w.others.length + w.live.length).toBe(0);
    });

    it('is not refused because the profile changed since: the job did not', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan({ isAcceptingJobs: false });
      const id = w.addJob({ status: 'ASSIGNED', artisanId: artisan });

      await assign(w, id, artisan);

      expect(w.job(id).artisanId).toBe(artisan);
    });

    it('once the artisan is on the road the job cannot be "assigned" to them again: 409', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan();

      for (const status of ['ARTISAN_ON_THE_WAY', 'ARTISAN_ARRIVED', 'IN_PROGRESS']) {
        const id = w.addJob({ status, artisanId: artisan });

        expect((await failure(assign(w, id, artisan, monday(9, 10)))).getStatus()).toBe(409);
        expect((await failure(assign(w, id, artisan))).getStatus()).toBe(409); // with no new time too: it is not "nothing to do"
        expect(w.job(id).status).toBe(status);
      }
    });
  });

  describe('what follows an assignment cannot undo it', () => {
    const failures: Array<[string, Options]> = [
      ['the notifications fail', { notifyThrows: true }],
      ['the timeline fails', { eventsThrow: true }],
      ['the live event fails', { liveThrows: true }],
      ['the reminders fail', { remindersThrow: true }],
    ];

    for (const [label, options] of failures) it(`when ${label} the job is still assigned and the caller gets the result`, async () => {
      const w = makeWorld(options);
      const first = w.addArtisan();
      const artisan = w.addArtisan();
      const id = w.addJob({ status: 'ASSIGNED', artisanId: first });
      const start = new Date(Date.now() + 72 * HOUR);

      const result = await assign(w, id, artisan, { startsAt: start, endsAt: new Date(start.getTime() + HOUR) });

      expect(result.intervention.artisanId).toBe(artisan);
      expect(w.job(id).artisanId).toBe(artisan);
      expect(w.appointments.rows.length).toBe(1);
    });

    it('when the new reminders cannot be written the old ones are still there: they are replaced in one transaction, not deleted first (P3-01)', async () => {
      const w = makeWorld({ remindersThrow: true });
      const artisan = w.addArtisan();
      const id = w.addJob({ status: 'ASSIGNED', artisanId: artisan });
      const start = new Date(Date.now() + 72 * HOUR);
      const appointment = w.appointments.insert({ interventionId: id, clientId: 1, artisanId: artisan, status: 'SCHEDULED', startsAt: start, endsAt: new Date(start.getTime() + HOUR) });

      w.reminders.insert({ appointmentId: appointment.id, recipientId: artisan, status: 'PENDING', minutesBefore: 120 });

      await assign(w, id, artisan, { startsAt: new Date(start.getTime() + HOUR), endsAt: new Date(start.getTime() + 2 * HOUR) });

      expect(w.reminders.rows.filter((r) => r.status === 'PENDING')).toHaveLength(1);
    });

    it('the reminders are written under the lock of the job, after the assignment has been committed (P3-01)', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const id = w.addJob({ status: 'ASSIGNED', artisanId: artisan });
      const start = new Date(Date.now() + 72 * HOUR);

      await assign(w, id, artisan, { startsAt: start, endsAt: new Date(start.getTime() + HOUR) });

      // the assignment takes the lock of the job and of the calendar; the reminders take the lock of the job again
      expect(w.locks.filter((values) => values.includes(id)).length).toBeGreaterThanOrEqual(2);
      expect(w.lockSql.length).toBe(3);
    });

    it('a cancellation that lands before the reminders are written: the visit is cancelled, so it gets none (P3-01)', async () => {
      let w: ReturnType<typeof makeWorld>;
      // the assignment takes two locks (job, calendar); the third is the reminders'
      w = makeWorld({ onLock: (taken) => { if (taken === 3) w.appointments.rows[0].status = 'CANCELLED'; } });
      const artisan = w.addArtisan();
      const id = w.addJob({ status: 'ASSIGNED', artisanId: artisan });
      const start = new Date(Date.now() + 72 * HOUR);

      await assign(w, id, artisan, { startsAt: start, endsAt: new Date(start.getTime() + HOUR) });

      expect(w.appointments.rows[0].status).toBe('CANCELLED');
      expect(w.reminders.rows).toHaveLength(0);
    });

    it('a later assignment that finished first: the reminders are made for the visit as it is now, for the artisan who has it', async () => {
      let w: ReturnType<typeof makeWorld>;
      let second = 0;
      const later = new Date(Date.now() + 100 * HOUR);

      w = makeWorld({
        onLock: (taken) => {
          if (taken !== 3) return;
          Object.assign(w.appointments.rows[0], { artisanId: second, startsAt: later, endsAt: new Date(later.getTime() + HOUR) });
        },
      });

      const first = w.addArtisan();
      second = w.addArtisan();
      const id = w.addJob({ status: 'ASSIGNED', artisanId: first });
      const start = new Date(Date.now() + 72 * HOUR);

      await assign(w, id, first, { startsAt: start, endsAt: new Date(start.getTime() + HOUR) });

      const pending = w.reminders.rows;

      expect(pending.length).toBe(4);
      expect(pending.some((r) => r.recipientId === second)).toBe(true);
      expect(pending.some((r) => r.recipientId === first)).toBe(false);
      // made for the time the visit has now (the day before is 24 hours ahead of it)
      expect(pending.filter((r) => r.minutesBefore === 1440).every((r) => r.dueAt.getTime() === later.getTime() - 1440 * 60000)).toBe(true);
    });

    it('a visit that lost its artisan meanwhile keeps no reminders', async () => {
      let w: ReturnType<typeof makeWorld>;

      w = makeWorld({ onLock: (taken) => { if (taken === 3) w.appointments.rows[0].artisanId = null; } });
      const artisan = w.addArtisan();
      const id = w.addJob({ status: 'ASSIGNED', artisanId: artisan });
      const start = new Date(Date.now() + 72 * HOUR);

      await assign(w, id, artisan, { startsAt: start, endsAt: new Date(start.getTime() + HOUR) });

      expect(w.appointments.rows[0].artisanId).toBe(null);
      expect(w.reminders.rows).toHaveLength(0);
    });

    it('a visit whose hour was cleared meanwhile keeps no reminders and the step does not fail', async () => {
      let w: ReturnType<typeof makeWorld>;

      w = makeWorld({ onLock: (taken) => { if (taken === 3) Object.assign(w.appointments.rows[0], { startsAt: null, endsAt: null }); } });
      const failures: string[] = [];
      (w.service as any).logger.error = (message: string) => failures.push(message);
      const artisan = w.addArtisan();
      const id = w.addJob({ status: 'ASSIGNED', artisanId: artisan });
      const start = new Date(Date.now() + 72 * HOUR);

      await assign(w, id, artisan, { startsAt: start, endsAt: new Date(start.getTime() + HOUR) });

      expect(w.appointments.rows[0].startsAt).toBe(null);
      expect(w.reminders.rows).toHaveLength(0);
      expect(failures).toEqual([]);
    });

    it('a visit that is gone meanwhile gets no reminders and the step does not fail', async () => {
      let w: ReturnType<typeof makeWorld>;

      w = makeWorld({ onLock: (taken) => { if (taken === 3) w.appointments.rows.splice(0, w.appointments.rows.length); } });
      const failures: string[] = [];
      (w.service as any).logger.error = (message: string) => failures.push(message);
      const artisan = w.addArtisan();
      const id = w.addJob({ status: 'ASSIGNED', artisanId: artisan });
      const start = new Date(Date.now() + 72 * HOUR);

      await assign(w, id, artisan, { startsAt: start, endsAt: new Date(start.getTime() + HOUR) });

      expect(w.appointments.rows).toHaveLength(0);
      expect(w.reminders.rows).toHaveLength(0);
      expect(failures).toEqual([]);
    });

    it('the other steps still run when one of them fails', async () => {
      const w = makeWorld({ eventsThrow: true });
      const artisan = w.addArtisan();
      const id = w.addJob();

      await assign(w, id, artisan);

      expect(w.notified.length).toBe(1);
      expect(w.live.length).toBe(1);
    });
  });

  it('the caller can ask for what comes back on the intervention', async () => {
    const w = makeWorld();
    const artisan = w.addArtisan();
    const id = w.addJob();
    const seen: any[] = [];
    const real = w.interventions.update;

    w.interventions.update = async (args: any) => {
      seen.push(args.include);
      return real(args);
    };

    await assign(w, id, artisan, { include: { client: true } });

    expect(seen).toEqual([{ client: true }]);
  });

  it('a user who is not an artisan is refused even if a profile row exists for them (inconsistent data)', async () => {
    const w = makeWorld();
    const notAnArtisan = w.addArtisan({}, { role: 'CLIENT' });
    const id = w.addJob();

    const error = await failure(assign(w, id, notAnArtisan));

    expect(error.getStatus()).toBe(404);
    expect(w.job(id).artisanId).toBe(null);
  });

  describe('the status the job lands on', () => {
    it('ASSIGNED unless the caller says "accepted" (the dashboard dropdown): then stored as ACCEPTED, the word the deployed apps read as "affecté", and the live event says so', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const first = w.addJob();
      const second = w.addJob();
      const third = w.addJob();

      await assign(w, first, artisan);
      await assign(w, second, artisan, { status: 'ARTISAN_ACCEPTED' });
      await assign(w, third, artisan, { status: 'ACCEPTED' }); // the old spelling

      expect(w.job(first).status).toBe('ASSIGNED');
      expect(w.job(second).status).toBe('ACCEPTED');
      expect(w.job(third).status).toBe('ACCEPTED');
      expect(w.live.map((event) => event.newStatus)).toEqual(['ASSIGNED', 'ACCEPTED', 'ACCEPTED']);
    });

    it('nothing else: a 400 before anything is written, locked or sent', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const id = w.addJob();

      for (const status of ['IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'ARTISAN_ON_THE_WAY', 'WAITING_ADMIN_REVIEW', 'NOT_A_STATUS', '']) {
        const error = await failure(assign(w, id, artisan, { status }));

        expect(error.getStatus()).toBe(400);
      }

      expect(w.job(id).status).toBe('WAITING_ADMIN_REVIEW');
      expect(w.job(id).artisanId).toBe(null);
      expect(w.locks.length).toBe(0);
    });

    it('a job handed over keeps the status asked for, and the live event says what it really is', async () => {
      const w = makeWorld();
      const first = w.addArtisan();
      const second = w.addArtisan();
      const id = w.addJob({ status: 'ARTISAN_ACCEPTED', artisanId: first });

      await assign(w, id, second, { status: 'ARTISAN_ACCEPTED' });

      expect(w.job(id).status).toBe('ARTISAN_ACCEPTED');
      expect(w.job(id).artisanId).toBe(second);
      expect(w.live.length).toBe(1); // the artisan changed, so the dashboards and the new artisan hear of it
      expect(w.live[0].oldStatus).toBe('ARTISAN_ACCEPTED');
      expect(w.live[0].newStatus).toBe('ARTISAN_ACCEPTED');
    });

    it('a new time for the same artisan changes neither the status nor the artisan: no status event', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const id = w.addJob({ status: 'ARTISAN_ACCEPTED', artisanId: artisan });

      await assign(w, id, artisan, monday(9, 10));

      expect(w.live.length).toBe(0);
      expect(w.others.length).toBe(2); // but both are told the new time
    });

    it('both are told the new time in French, and the same notice carries its Arabic for the reader who chose it, with the date and the hour set apart (P3-04)', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const id = w.addJob({ status: 'ARTISAN_ACCEPTED', artisanId: artisan });

      await assign(w, id, artisan, monday(9, 10));

      expect(w.others.length).toBe(2);

      for (const payload of w.others) {
        expect(payload.title).toBe('Rendez-vous modifié');
        expect(payload.message).toMatch(/^Le rendez-vous de l’intervention #\d+ est fixé le \d{2}\/\d{2}\/\d{4} à \d{2}:\d{2}\.$/);
        expect(typeof payload.texts).toBe('function');
        expect(payload.texts('fr')).toEqual({ title: payload.title, message: payload.message });

        const arabic = payload.texts('ar');

        expect(arabic.title).toBe('تم تغيير الموعد');
        expect(arabic.message).toMatch(/^تم تحديد موعد التدخّل ⁨#\d+⁩: ⁨\d{2}\/\d{2}\/\d{4}⁩ الساعة ⁨\d{2}:\d{2}⁩\.$/);
      }
    });
  });

  describe('an appointment that is over, or cancelled, when the job changes hands', () => {
    it('a visit already in the past is no time to check the new artisan against: only the profile counts', async () => {
      const w = makeWorld();
      const first = w.addArtisan();
      const second = w.addArtisan({ availability: [{ dayOfWeek: 'MONDAY', startTime: '08:00', endTime: '09:00', isAvailable: false }] }); // never free, at any time
      const id = w.addJob({ status: 'ASSIGNED', artisanId: first });
      const start = new Date(Date.now() - 48 * HOUR);
      const appointment = w.appointments.insert({ interventionId: id, clientId: 1, artisanId: first, status: 'SCHEDULED', startsAt: start, endsAt: new Date(start.getTime() + HOUR) });
      w.reminders.insert({ appointmentId: appointment.id, recipientId: first, status: 'PENDING', minutesBefore: 120 });

      await assign(w, id, second);

      expect(w.job(id).artisanId).toBe(second);
      // the old appointment is no longer in the name of the artisan who lost the job, and not in the
      // name of the new one either (who never agreed to that time); its time is not rewritten
      expect(w.appointments.rows[0].artisanId).toBe(null);
      expect(w.appointments.rows[0].startsAt.getTime()).toBe(start.getTime());
      // nobody is told about a date that is gone, and nobody is reminded of it
      expect(w.notified[0][3]).toBe(undefined);
      expect(w.reminders.rows.filter((r) => r.status === 'PENDING').length).toBe(0);
    });

    it('the profile still counts for a past visit: an artisan who takes no missions is refused', async () => {
      const w = makeWorld();
      const first = w.addArtisan();
      const second = w.addArtisan({ isAcceptingJobs: false });
      const id = w.addJob({ status: 'ASSIGNED', artisanId: first });
      const start = new Date(Date.now() - 48 * HOUR);
      w.appointments.insert({ interventionId: id, clientId: 1, artisanId: first, status: 'SCHEDULED', startsAt: start, endsAt: new Date(start.getTime() + HOUR) });

      const error = await failure(assign(w, id, second));

      expect(error.getResponse().issues).toEqual(['Artisan ne prend pas de missions.']);
      expect(w.appointments.rows[0].artisanId).toBe(first);
    });

    it('a cancelled appointment is not reused as the visit, and it is in nobody\'s name: not the artisan who lost the job, not the new one', async () => {
      const w = makeWorld();
      const first = w.addArtisan();
      const second = w.addArtisan();
      const id = w.addJob({ status: 'ASSIGNED', artisanId: first });
      const future = monday(9, 11);
      w.appointments.insert({ interventionId: id, clientId: 1, artisanId: first, status: 'CANCELLED', ...future });

      await assign(w, id, second);

      expect(w.appointments.rows[0].artisanId).toBe(null);
      expect(w.appointments.rows[0].status).toBe('CANCELLED');
      expect(w.reminders.rows.length).toBe(0); // no reminders for a visit that is cancelled
    });

    it('a request to cancel does not free the slot until it is approved', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const other = w.addJob({ status: 'ASSIGNED', artisanId: artisan });
      w.appointments.insert({ interventionId: other, clientId: 1, artisanId: artisan, status: 'CANCEL_REQUESTED', ...monday(9, 11) });
      const id = w.addJob();

      const error = await failure(assign(w, id, artisan, monday(10, 12)));

      expect(error.getResponse().issues).toEqual(['Artisan déjà réservé sur ce créneau.']);
    });
  });

  describe('requests about an appointment that is rewritten or taken away', () => {
    const request = (w: World, appointmentId: number, fields: Record<string, unknown> = {}) =>
      w.requests.insert({ appointmentId, requestedById: 5, ...fields });

    it('a new time for the same artisan closes the pending requests about the old time, and leaves the answered ones alone', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const id = w.addJob({ status: 'ASSIGNED', artisanId: artisan });
      const appointment = w.appointments.insert({ interventionId: id, clientId: 1, artisanId: artisan, status: 'RESCHEDULE_REQUESTED', ...monday(9, 10) });
      const pending = request(w, appointment.id, { status: 'PENDING' });
      const approved = request(w, appointment.id, { status: 'APPROVED', adminResponse: 'Ok' });

      await assign(w, id, artisan, monday(14, 15));

      const rows = w.requests.rows;

      expect(rows.find((row) => row.id === pending.id)!.status).toBe('CANCELLED');
      expect(rows.find((row) => row.id === pending.id)!.reviewedById).toBe(99);
      expect(rows.find((row) => row.id === pending.id)!.reviewedAt instanceof Date).toBe(true);
      expect(String(rows.find((row) => row.id === pending.id)!.adminResponse).length > 10).toBe(true);
      expect(rows.find((row) => row.id === approved.id)!.status).toBe('APPROVED');
      expect(rows.find((row) => row.id === approved.id)!.adminResponse).toBe('Ok');
      expect(w.appointments.rows[0].status).toBe('SCHEDULED');
    });

    it('a new time is a new plan: the confirmation the artisan gave to the old time goes (P3-01), whoever holds the job', async () => {
      for (const same of [true, false]) {
        const w = makeWorld();
        const first = w.addArtisan();
        const second = same ? first : w.addArtisan();
        const id = w.addJob({ status: 'ASSIGNED', artisanId: first });

        w.appointments.insert({ interventionId: id, clientId: 1, artisanId: first, status: 'CONFIRMED', confirmedAt: new Date(), ...monday(9, 10) });

        await assign(w, id, second, monday(14, 15));

        expect(w.appointments.rows[0].status).toBe('SCHEDULED');
        expect(w.appointments.rows[0].confirmedAt).toBe(null);
        expect(w.appointments.rows[0].artisanId).toBe(second);
      }
    });

    it('a job handed to another artisan with a new time closes them too', async () => {
      const w = makeWorld();
      const first = w.addArtisan();
      const second = w.addArtisan();
      const id = w.addJob({ status: 'ASSIGNED', artisanId: first });
      const appointment = w.appointments.insert({ interventionId: id, clientId: 1, artisanId: first, status: 'CANCEL_REQUESTED', ...monday(9, 10) });
      const pending = request(w, appointment.id, { type: 'CANCEL' });

      await assign(w, id, second, monday(14, 15));

      expect(w.requests.rows.find((row) => row.id === pending.id)!.status).toBe('CANCELLED');
      expect(w.appointments.rows[0].artisanId).toBe(second);
      expect(w.appointments.rows[0].status).toBe('SCHEDULED');
    });

    it('a job handed over without a time, the old appointment taken out of the old artisan\'s name: its pending requests are closed', async () => {
      const w = makeWorld();
      const first = w.addArtisan();
      const second = w.addArtisan();
      const id = w.addJob({ status: 'ASSIGNED', artisanId: first });
      const start = new Date(Date.now() - 48 * HOUR);
      const appointment = w.appointments.insert({ interventionId: id, clientId: 1, artisanId: first, status: 'RESCHEDULE_REQUESTED', startsAt: start, endsAt: new Date(start.getTime() + HOUR) });
      const pending = request(w, appointment.id);

      await assign(w, id, second);

      expect(w.requests.rows.find((row) => row.id === pending.id)!.status).toBe('CANCELLED');
      expect(w.appointments.rows[0].artisanId).toBe(null);
    });

    it('the status of the old visit stops saying a request is open: a cancellation asked for is a cancelled visit, a move asked for is a planned one', async () => {
      const w = makeWorld();
      const first = w.addArtisan();
      const second = w.addArtisan();
      const start = new Date(Date.now() - 48 * HOUR);
      const range = { startsAt: start, endsAt: new Date(start.getTime() + HOUR) };
      const cancelJob = w.addJob({ status: 'ASSIGNED', artisanId: first });
      const moveJob = w.addJob({ status: 'ASSIGNED', artisanId: first });
      const plainJob = w.addJob({ status: 'ASSIGNED', artisanId: first });
      w.appointments.insert({ interventionId: cancelJob, clientId: 1, artisanId: first, status: 'CANCEL_REQUESTED', ...range });
      w.appointments.insert({ interventionId: moveJob, clientId: 1, artisanId: first, status: 'RESCHEDULE_REQUESTED', ...range });
      w.appointments.insert({ interventionId: plainJob, clientId: 1, artisanId: first, status: 'SCHEDULED', ...range });

      await assign(w, cancelJob, second);
      await assign(w, moveJob, second);
      await assign(w, plainJob, second);

      const byJob = (id: number) => w.appointments.rows.find((row) => row.interventionId === id)!;

      expect(byJob(cancelJob).status).toBe('CANCELLED');
      expect(byJob(cancelJob).cancelledAt instanceof Date).toBe(true);
      expect(String(byJob(cancelJob).cancelReason).length > 5).toBe(true);
      expect(byJob(moveJob).status).toBe('SCHEDULED');
      expect(byJob(plainJob).status).toBe('SCHEDULED'); // an old planned visit is left as it was
      expect(w.appointments.rows.every((row) => row.artisanId === null)).toBe(true);
    });

    it('requests about the appointment of another job are not touched', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const id = w.addJob({ status: 'ASSIGNED', artisanId: artisan });
      const otherJob = w.addJob({ status: 'ASSIGNED', artisanId: artisan });
      const mine = w.appointments.insert({ interventionId: id, clientId: 1, artisanId: artisan, status: 'SCHEDULED', ...monday(9, 10) });
      const other = w.appointments.insert({ interventionId: otherJob, clientId: 1, artisanId: artisan, status: 'SCHEDULED', ...monday(12, 13) });
      request(w, mine.id);
      const untouched = request(w, other.id);

      await assign(w, id, artisan, monday(14, 15));

      expect(w.requests.rows.find((row) => row.id === untouched.id)!.status).toBe('PENDING');
    });

    it('an appointment nobody holds (the client only asked for a time) is left as it is when a first artisan is given the job: not put in their name, its requests not closed', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const id = w.addJob();
      const appointment = w.appointments.insert({ interventionId: id, clientId: 1, artisanId: null, status: 'REQUESTED', preferredDate: new Date() });
      const pending = request(w, appointment.id);

      await assign(w, id, artisan);

      expect(w.appointments.rows[0].artisanId).toBe(null);
      expect(w.appointments.rows[0].status).toBe('REQUESTED');
      expect(w.requests.rows.find((row) => row.id === pending.id)!.status).toBe('PENDING');
    });

    it('nothing changed (the same visit sent again, or the same artisan with no time): the pending requests stay pending', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const id = w.addJob({ status: 'ASSIGNED', artisanId: artisan });
      const range = monday(9, 10);
      const appointment = w.appointments.insert({ interventionId: id, clientId: 1, artisanId: artisan, status: 'SCHEDULED', ...range });
      const pending = request(w, appointment.id);

      await assign(w, id, artisan, range);
      await assign(w, id, artisan);

      expect(w.requests.rows.find((row) => row.id === pending.id)!.status).toBe('PENDING');
    });

    it('an assignment that is refused closes nothing', async () => {
      const w = makeWorld();
      const first = w.addArtisan();
      const second = w.addArtisan({ isAcceptingJobs: false });
      const id = w.addJob({ status: 'ASSIGNED', artisanId: first });
      const appointment = w.appointments.insert({ interventionId: id, clientId: 1, artisanId: first, status: 'SCHEDULED', ...monday(9, 10) });
      const pending = request(w, appointment.id);

      await failure(assign(w, id, second, monday(14, 15)));

      expect(w.requests.rows.find((row) => row.id === pending.id)!.status).toBe('PENDING');
    });
  });

  describe('the timeline line', () => {
    it('does not give the time of an old visit that was only taken out of the old artisan\'s name', async () => {
      const w = makeWorld();
      const first = w.addArtisan();
      const second = w.addArtisan();
      const id = w.addJob({ status: 'ASSIGNED', artisanId: first });
      const start = new Date(Date.now() - 48 * HOUR);
      w.appointments.insert({ interventionId: id, clientId: 1, artisanId: first, status: 'SCHEDULED', startsAt: start, endsAt: new Date(start.getTime() + HOUR) });

      await assign(w, id, second);

      expect(w.events[0].metadata.startsAt).toBe(null);
      expect(w.events[0].metadata.endsAt).toBe(null);
      expect(w.events[0].metadata.previousArtisanId).toBe(first);
    });

    it('gives the time of the visit that was scheduled', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const id = w.addJob();
      const range = monday(9, 10);

      await assign(w, id, artisan, range);

      expect(w.events[0].metadata.startsAt).toBe(range.startsAt.toISOString());
      expect(w.events[0].metadata.endsAt).toBe(range.endsAt.toISOString());
    });
  });

  describe('numbers the database cannot hold', () => {
    it('a job or an artisan id beyond a 32-bit integer is a 404 before any lock or query, not an error 500', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const id = w.addJob();

      for (const [job, who] of [[99_999_999_999, artisan], [id, 99_999_999_999], [0, artisan], [id, -1], [1.5, artisan], [Number.NaN, artisan]]) {
        const error = await failure(assign(w, job, who));

        expect(error.getStatus()).toBe(404);
      }

      expect(w.locks.length).toBe(0);
    });
  });

  describe('the same visit sent again', () => {
    it('the same artisan and the same hours: nothing is written, nobody is told, a visit the artisan confirmed stays confirmed', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const id = w.addJob({ status: 'ARTISAN_ACCEPTED', artisanId: artisan });
      w.appointments.insert({ interventionId: id, clientId: 1, artisanId: artisan, status: 'CONFIRMED', ...monday(9, 11) });

      await assign(w, id, artisan, monday(9, 11));

      expect(w.appointments.rows[0].status).toBe('CONFIRMED');
      expect(w.appointments.rows[0].scheduledById).toBe(undefined);
      expect(w.events.length + w.notified.length + w.others.length + w.live.length + w.reminders.rows.length).toBe(0);
    });

    it('one end different is a different visit: only the start, only the end', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const id = w.addJob({ status: 'ARTISAN_ACCEPTED', artisanId: artisan });
      w.appointments.insert({ interventionId: id, clientId: 1, artisanId: artisan, status: 'CONFIRMED', ...monday(9, 11) });

      await assign(w, id, artisan, monday(10, 11)); // the start moved

      expect(w.appointments.rows[0].startsAt.getTime()).toBe(monday(10, 11).startsAt.getTime());
      expect(w.events.length).toBe(1);

      await assign(w, id, artisan, monday(10, 12)); // the end moved

      expect(w.appointments.rows[0].endsAt.getTime()).toBe(monday(10, 12).endsAt.getTime());
      expect(w.events.length).toBe(2);
    });

    it('a different hour is a change like any other', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const id = w.addJob({ status: 'ARTISAN_ACCEPTED', artisanId: artisan });
      w.appointments.insert({ interventionId: id, clientId: 1, artisanId: artisan, status: 'CONFIRMED', adminNote: 'Sonner', ...monday(9, 11) });

      await assign(w, id, artisan, monday(13, 14));

      expect(w.appointments.rows[0].startsAt.getTime()).toBe(monday(13, 14).startsAt.getTime());
      expect(w.appointments.rows[0].status).toBe('SCHEDULED');
      expect(w.events.length).toBe(1);
      expect(w.others.length).toBe(2);
    });

    it('a different note on the same visit writes the note and nothing else: the status, the waiting requests and the people told do not change', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const id = w.addJob({ status: 'ARTISAN_ACCEPTED', artisanId: artisan });
      const appointment = w.appointments.insert({ interventionId: id, clientId: 1, artisanId: artisan, status: 'CANCEL_REQUESTED', adminNote: 'Sonner', ...monday(9, 11) });
      const pending = w.requests.insert({ appointmentId: appointment.id, requestedById: 1, type: 'CANCEL' });

      const result = await assign(w, id, artisan, { ...monday(9, 11), adminNote: 'Appeler avant' });

      expect(w.appointments.rows[0].adminNote).toBe('Appeler avant');
      expect(result.appointment.adminNote).toBe('Appeler avant');
      expect(w.appointments.rows[0].status).toBe('CANCEL_REQUESTED');
      expect(w.requests.rows.find((row) => row.id === pending.id)!.status).toBe('PENDING');
      expect(w.events.length + w.notified.length + w.others.length + w.live.length + w.reminders.rows.length).toBe(0);
    });

    it('a note sent without a time for the artisan who has the job is not attached to anything: nothing is written', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const id = w.addJob({ status: 'ARTISAN_ACCEPTED', artisanId: artisan });
      w.appointments.insert({ interventionId: id, clientId: 1, artisanId: artisan, status: 'CONFIRMED', adminNote: 'Sonner', ...monday(9, 11) });

      await assign(w, id, artisan, { adminNote: 'Autre chose' });

      expect(w.appointments.rows[0].adminNote).toBe('Sonner');
    });

    it('no note sent, or the same note: the visit is not touched at all', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const id = w.addJob({ status: 'ARTISAN_ACCEPTED', artisanId: artisan });
      w.appointments.insert({ interventionId: id, clientId: 1, artisanId: artisan, status: 'CONFIRMED', adminNote: 'Sonner', ...monday(9, 11) });

      await assign(w, id, artisan, { ...monday(9, 11) });
      await assign(w, id, artisan, { ...monday(9, 11), adminNote: 'Sonner' });

      expect(w.appointments.rows[0].adminNote).toBe('Sonner');
      expect(w.appointments.rows[0].status).toBe('CONFIRMED');
    });
  });

  describe('a new time for the artisan who already has the job', () => {
    it('only the time is looked at: an artisan who stopped taking new missions, is at their maximum, or does not take urgent jobs keeps this one', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan({ isAcceptingJobs: false, emergencyAvailable: false, maxActiveJobs: 1 });
      const id = w.addJob({ status: 'ARTISAN_ACCEPTED', artisanId: artisan, urgency: 'EMERGENCY' });
      w.addJob({ status: 'ASSIGNED', artisanId: artisan });

      await assign(w, id, artisan, monday(9, 11));

      expect(w.appointments.rows[0].artisanId).toBe(artisan);
    });

    it('but the time must still be free: booked, blocked or outside the weekly hours is refused', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan({ isAcceptingJobs: false });
      const id = w.addJob({ status: 'ARTISAN_ACCEPTED', artisanId: artisan });
      const other = w.addJob({ status: 'ASSIGNED', artisanId: artisan });
      w.appointments.insert({ interventionId: other, clientId: 1, artisanId: artisan, status: 'SCHEDULED', ...monday(9, 11) });
      w.blocks.insert({ artisanId: artisan, type: 'VACATION', ...monday(14, 16) });

      expect((await failure(assign(w, id, artisan, monday(10, 12)))).getResponse().issues).toEqual(['Artisan déjà réservé sur ce créneau.']);
      expect((await failure(assign(w, id, artisan, monday(15, 16)))).getResponse().issues).toEqual(['Artisan indisponible sur ce créneau.']);
    });
  });

  describe('the locks', () => {
    it('are held until the end of the transaction (xact), the job first and the artisan second', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const id = w.addJob();

      await assign(w, id, artisan);

      expect(w.lockSql.length).toBe(2);
      for (const sql of w.lockSql) {
        expect(/pg_advisory_xact_lock\(/.test(sql)).toBe(true);
        expect(/pg_advisory_lock\(|pg_try_advisory/.test(sql)).toBe(false);
      }
      expect(w.locks).toEqual([[71001, id], [71002, artisan]]);
    });
  });

  describe('the appointment it writes', () => {
    it('is stamped with the time zone of the business and the staff member who scheduled it', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const id = w.addJob();

      await assign(w, id, artisan, monday(8, 10));

      const appointment = w.appointments.rows[0];

      expect(appointment.timezone).toBe('Africa/Tunis');
      expect(appointment.scheduledById).toBe(99);
      expect(appointment.status).toBe('SCHEDULED');
    });

    it('follows BUSINESS_TIMEZONE', async () => {
      const before = process.env.BUSINESS_TIMEZONE;
      process.env.BUSINESS_TIMEZONE = 'Europe/Paris';

      try {
        const w = makeWorld();
        const artisan = w.addArtisan();
        const id = w.addJob();

        await assign(w, id, artisan, monday(8, 10));

        expect(w.appointments.rows[0].timezone).toBe('Europe/Paris');
      } finally {
        if (before === undefined) delete process.env.BUSINESS_TIMEZONE;
        else process.env.BUSINESS_TIMEZONE = before;
      }
    });

    it('a new time written over an old one names the new staff member too', async () => {
      const w = makeWorld();
      const artisan = w.addArtisan();
      const id = w.addJob();

      await assign(w, id, artisan, monday(8, 10));
      w.appointments.rows[0].scheduledById = 7;
      w.appointments.rows[0].timezone = 'Europe/Paris'; // what the schema writes when nobody says
      await w.service.assign({ interventionId: id, artisanId: artisan, actorId: 42, ...monday(14, 15) });

      expect(w.appointments.rows.length).toBe(1);
      expect(w.appointments.rows[0].scheduledById).toBe(42);
      expect(w.appointments.rows[0].timezone).toBe('Africa/Tunis');
    });
  });
});

describe('giving a job that was offered to several artisans (P3-07)', () => {
  const FAR = new Date('2100-01-01T00:00:00Z');
  const PAST = new Date('2000-01-01T00:00:00Z');

  it('the offers still waiting end: the chosen artisan\'s is accepted, the others\' are withdrawn as assigned, and each of them is told live', async () => {
    const w = makeWorld();
    const [chosen, other, third] = [w.addArtisan(), w.addArtisan(), w.addArtisan()];
    const id = w.addJob();

    for (const [rank, artisanId] of [chosen, other, third].entries()) w.offers.insert({ interventionId: id, artisanId, rank: rank + 1, expiresAt: FAR });

    await assign(w, id, chosen);

    const of = (artisanId: number) => w.offers.rows.find((row) => row.artisanId === artisanId)!;

    expect(of(chosen).status).toBe('ACCEPTED');
    expect([of(other).status, of(other).withdrawnReason]).toEqual(['WITHDRAWN', 'ASSIGNED']);
    expect([of(third).status, of(third).withdrawnReason]).toEqual(['WITHDRAWN', 'ASSIGNED']);
    expect(w.offers.rows.filter((row) => row.status === 'PENDING')).toHaveLength(0);
    // the technician who got the job is not told their offer was withdrawn
    expect(w.offerEvents.map(([userId, payload]) => [userId, payload]).sort()).toEqual(
      [other, third].sort().map((userId) => [userId, { interventionId: id, status: 'withdrawn', because: 'assigned' }]),
    );
  });

  it('an offer that had run out is expired, not withdrawn: nobody is told a job was taken from under them', async () => {
    const w = makeWorld();
    const [chosen, lapsed] = [w.addArtisan(), w.addArtisan()];
    const id = w.addJob();

    w.offers.insert({ interventionId: id, artisanId: lapsed, rank: 1, expiresAt: PAST });

    await assign(w, id, chosen);

    expect(w.offers.rows[0].status).toBe('EXPIRED');
    expect(w.offerEvents).toEqual([]);
  });

  it('a refusal changes no offer: the job stays offered', async () => {
    const w = makeWorld();
    const [away, other] = [w.addArtisan({ isAcceptingJobs: false }), w.addArtisan()];
    const id = w.addJob();

    w.offers.insert({ interventionId: id, artisanId: other, rank: 1, expiresAt: FAR });

    expect((await failure(assign(w, id, away))).getStatus()).toBe(400);
    expect(w.offers.rows[0].status).toBe('PENDING');
    expect(w.offerEvents).toEqual([]);
  });

  it('a live event that fails does not undo the assignment or the withdrawals', async () => {
    const w = makeWorld();
    const [chosen, other] = [w.addArtisan(), w.addArtisan()];
    const id = w.addJob();

    w.offers.insert({ interventionId: id, artisanId: other, rank: 1, expiresAt: FAR });
    (w.service as any).realtime.emitOfferUpdate = () => {
      throw new Error('socket down');
    };

    await assign(w, id, chosen);

    expect(w.job(id).artisanId).toBe(chosen);
    expect(w.offers.rows[0].status).toBe('WITHDRAWN');
  });

  it('the same artisan given the job again changes nothing: offers are left alone', async () => {
    const w = makeWorld();
    const chosen = w.addArtisan();
    const other = w.addArtisan();
    const id = w.addJob();

    await assign(w, id, chosen);
    w.offers.insert({ interventionId: id, artisanId: other, rank: 1, expiresAt: FAR });
    w.offerEvents.length = 0;

    await assign(w, id, chosen);

    expect(w.offers.rows[0].status).toBe('PENDING');
    expect(w.offerEvents).toEqual([]);
  });
});
