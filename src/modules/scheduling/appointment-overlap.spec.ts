import { ConflictException } from '@nestjs/common';

import { ACTIVE_APPOINTMENT_STATUSES } from '../assignment/artisan-availability';
import { emptyWorld, World } from '../../common/testing/world';
import { MemoryPrisma } from '../../common/testing/memory-prisma';

import { ensureOverlapConstraint } from './appointment-constraints';
import {
  APPOINTMENT_OVERLAP_CONSTRAINT,
  OVERLAP_MESSAGE,
  findClashingVisits,
  holdsTheCalendar,
  isOverlapViolation,
  overlapAsConflict,
  overlapConstraintStatements,
  visitsClash,
} from './appointment-overlap';

/**
 * Two visits of one artisan at the same time, refused by the database itself (P3-01).
 *
 * The rule is written once (appointment-overlap.ts) and used three times: as the SQL that PostgreSQL enforces, as the rule the test
 * database enforces (the same function), and as the list of clashes the apply script shows before it creates the constraint.
 */

const at = (hour: number, minute = 0) => new Date(Date.UTC(2099, 9, 19, hour, minute));

const visit = (data: Record<string, any> = {}) => ({ artisanId: 4, startsAt: at(8), endsAt: at(10), status: 'SCHEDULED', ...data });

async function failure(work: () => Promise<unknown>): Promise<any> {
  try {
    await work();
  } catch (error) {
    return error;
  }

  throw new Error('expected a failure');
}

describe('the rule: which visits clash', () => {
  it('two hours that cross, for one artisan, both holding the calendar', () => {
    expect(visitsClash(visit(), visit({ startsAt: at(9), endsAt: at(11) }))).toBe(true);
    expect(visitsClash(visit(), visit({ startsAt: at(7), endsAt: at(8, 1) }))).toBe(true);
    expect(visitsClash(visit({ startsAt: at(8), endsAt: at(18) }), visit({ startsAt: at(12), endsAt: at(13) }))).toBe(true);
  });

  it('a visit that ends when the next one starts does not clash (half-open hours, like the check before a booking)', () => {
    expect(visitsClash(visit(), visit({ startsAt: at(10), endsAt: at(12) }))).toBe(false);
    expect(visitsClash(visit(), visit({ startsAt: at(6), endsAt: at(8) }))).toBe(false);
  });

  it('another artisan, the same hour: no clash', () => {
    expect(visitsClash(visit(), visit({ artisanId: 5 }))).toBe(false);
  });

  it('only the states that hold the artisan\'s calendar count: the same list the check before a booking reads', () => {
    for (const status of ACTIVE_APPOINTMENT_STATUSES) expect(visitsClash(visit(), visit({ status }))).toBe(true);

    for (const status of ['REQUESTED', 'CANCELLED', 'COMPLETED', 'NO_SHOW']) {
      expect(visitsClash(visit(), visit({ status }))).toBe(false);
      expect(visitsClash(visit({ status }), visit())).toBe(false);
    }
  });

  it('a visit with no artisan, no hours, or hours that do not run forward holds nothing', () => {
    expect(holdsTheCalendar(visit({ artisanId: null }))).toBe(false);
    expect(holdsTheCalendar(visit({ startsAt: null }))).toBe(false);
    expect(holdsTheCalendar(visit({ endsAt: null }))).toBe(false);
    expect(holdsTheCalendar(visit({ startsAt: at(10), endsAt: at(8) }))).toBe(false);
    expect(holdsTheCalendar(visit({ startsAt: at(10), endsAt: at(10) }))).toBe(false);
    expect(visitsClash(visit({ artisanId: null }), visit({ artisanId: null }))).toBe(false);
  });

  it('lists the pairs that clash already, once each, and none when nothing does', () => {
    const rows = [
      { id: 1, ...visit() },
      { id: 2, ...visit({ startsAt: at(9), endsAt: at(11) }) },
      { id: 3, ...visit({ startsAt: at(10, 30), endsAt: at(12) }) },
      { id: 4, ...visit({ artisanId: 9 }) },
      { id: 5, ...visit({ status: 'CANCELLED' }) },
    ];

    expect(findClashingVisits(rows).map(([a, b]) => [a.id, b.id])).toEqual([
      [1, 2],
      [2, 3],
    ]);
    expect(findClashingVisits([rows[0], rows[3], rows[4]])).toEqual([]);
    expect(findClashingVisits([])).toEqual([]);
  });

  it('a long visit that crosses several others clashes with each of them, not only with the one next to it', () => {
    const rows = [
      { id: 1, ...visit({ startsAt: at(8), endsAt: at(14) }) },
      { id: 2, ...visit({ startsAt: at(9), endsAt: at(10) }) },
      { id: 3, ...visit({ startsAt: at(11), endsAt: at(12) }) },
      { id: 4, ...visit({ startsAt: at(13), endsAt: at(15) }) },
    ];

    expect(findClashingVisits(rows).map(([a, b]) => [a.id, b.id])).toEqual([
      [1, 2],
      [1, 3],
      [1, 4],
    ]);
  });

  it('looks at each artisan\'s calendar on its own: the visits of several artisans that cross in time are no clash, and each artisan\'s own pairs are all found', () => {
    const rows = [
      { id: 1, ...visit({ artisanId: 4 }) },
      { id: 2, ...visit({ artisanId: 9 }) },
      { id: 3, ...visit({ artisanId: 4, startsAt: at(9), endsAt: at(11) }) },
      { id: 4, ...visit({ artisanId: 9, startsAt: at(9), endsAt: at(11) }) },
      { id: 5, ...visit({ artisanId: 12 }) },
    ];

    expect(findClashingVisits(rows).map(([a, b]) => [a.id, b.id])).toEqual([
      [1, 3],
      [2, 4],
    ]);
  });
});

describe('the SQL says the same thing as the rule', () => {
  const [extension, constraint] = overlapConstraintStatements();

  it('needs btree_gist, and names the constraint the error is recognised by', () => {
    expect(extension).toBe('CREATE EXTENSION IF NOT EXISTS btree_gist');
    expect(constraint).toContain(`ADD CONSTRAINT "${APPOINTMENT_OVERLAP_CONSTRAINT}"`);
    expect(constraint).toContain('EXCLUDE USING gist');
  });

  it('is on one artisan and on the hours that cross', () => {
    expect(constraint).toContain('"artisanId" WITH =');
    expect(constraint).toContain('tsrange("startsAt", "endsAt") WITH &&');
  });

  it('holds only for the visits that hold the calendar, by the list the service uses', () => {
    for (const status of ACTIVE_APPOINTMENT_STATUSES) expect(constraint).toContain(`'${status}'`);

    for (const status of ['REQUESTED', 'CANCELLED', 'COMPLETED', 'NO_SHOW']) expect(constraint).not.toContain(`'${status}'`);

    expect(constraint).toContain('"artisanId" IS NOT NULL');
    expect(constraint).toContain('"startsAt" < "endsAt"');
  });
});

describe('what the error of the database looks like', () => {
  const message = `conflicting key value violates exclusion constraint "${APPOINTMENT_OVERLAP_CONSTRAINT}"`;

  it('is recognised wherever the code travels: the driver, Prisma\'s meta, the adapter\'s cause, or only the message', () => {
    expect(isOverlapViolation({ code: '23P01' })).toBe(true);
    expect(isOverlapViolation({ code: 'P2010', meta: { code: '23P01' } })).toBe(true);
    expect(isOverlapViolation({ cause: { originalCode: '23P01' } })).toBe(true);
    expect(isOverlapViolation({ cause: { sqlState: '23P01' } })).toBe(true);
    expect(isOverlapViolation({ sqlState: '23P01' })).toBe(true);
    expect(isOverlapViolation({ originalCode: '23P01' })).toBe(true);
    expect(isOverlapViolation({ meta: { driverAdapterError: { cause: { code: '23P01' } } } })).toBe(true);
    expect(isOverlapViolation({ constraint: APPOINTMENT_OVERLAP_CONSTRAINT })).toBe(true);
    expect(isOverlapViolation(new Error(`Invalid invocation: ${message}`))).toBe(true);
  });

  it('is not mistaken for another error', () => {
    expect(isOverlapViolation({ code: 'P2002', meta: { target: ['interventionId'] } })).toBe(false);
    expect(isOverlapViolation({ code: '23505' })).toBe(false);
    expect(isOverlapViolation(new Error('connection reset'))).toBe(false);
    expect(isOverlapViolation(new Error('conflicting key value violates exclusion constraint "Another_constraint"'))).toBe(false);
    expect(isOverlapViolation(null)).toBe(false);
    expect(isOverlapViolation(undefined)).toBe(false);
    expect(isOverlapViolation('23P01')).toBe(false);
  });

  it('an error that points at itself is not followed for ever', () => {
    const loop: any = { code: 'X' };

    loop.cause = loop;

    expect(isOverlapViolation(loop)).toBe(false);
  });

  it('becomes a 409 for the person, with a sentence to read; any other error goes on as it is', () => {
    const conflict = overlapAsConflict({ code: '23P01' });

    expect(conflict instanceof ConflictException).toBe(true);
    expect((conflict as ConflictException).getStatus()).toBe(409);
    expect((conflict as ConflictException).message).toBe(OVERLAP_MESSAGE);

    const other = new Error('boom');

    expect(overlapAsConflict(other)).toBe(other);
  });
});

describe('the database refuses the second booking (the test database follows the same rule)', () => {
  function calendar() {
    const world = emptyWorld();
    const m = world.memory;
    const client = m.plant('user', { role: 'CLIENT' });
    const artisan = m.plant('user', { role: 'ARTISAN' });
    const other = m.plant('user', { role: 'ARTISAN' });
    const job = () => m.plant('intervention', { clientId: client.id, artisanId: artisan.id, status: 'ASSIGNED' });
    const book = (data: Record<string, any>) =>
      world.prisma.appointment.create({ data: { clientId: client.id, status: 'SCHEDULED', artisanId: artisan.id, startsAt: at(8), endsAt: at(10), ...data } });
    const stored = () => m.rows('appointment');

    return { world, m, client, artisan, other, job, book, stored };
  }

  it('two overlapping bookings for one artisan cannot both be saved: the first stands, the second is refused with the database\'s own error', async () => {
    const c = calendar();

    await c.book({ interventionId: c.job().id });

    const error = await failure(() => c.book({ interventionId: c.job().id, startsAt: at(9), endsAt: at(11) }));

    expect(isOverlapViolation(error)).toBe(true);
    expect(c.stored()).toHaveLength(1);
  });

  it('whatever the status that holds the calendar: confirmed, or waiting for an answer to a request', async () => {
    for (const status of ['CONFIRMED', 'RESCHEDULE_REQUESTED', 'CANCEL_REQUESTED']) {
      const c = calendar();

      await c.book({ interventionId: c.job().id, status });

      const error = await failure(() => c.book({ interventionId: c.job().id, startsAt: at(9), endsAt: at(9, 30) }));

      expect(isOverlapViolation(error)).toBe(true);
    }
  });

  it('a visit that starts when the other ends, another artisan at the same hour, and a cancelled visit do not stand in the way', async () => {
    const c = calendar();

    await c.book({ interventionId: c.job().id });
    await c.book({ interventionId: c.job().id, startsAt: at(10), endsAt: at(12) });
    await c.book({ interventionId: c.job().id, artisanId: c.other.id });
    await c.book({ interventionId: c.job().id, status: 'CANCELLED' });
    await c.book({ interventionId: c.job().id, status: 'REQUESTED', startsAt: null, endsAt: null });

    expect(c.stored()).toHaveLength(5);
  });

  it('a visit can be moved within its own hours: it does not clash with itself', async () => {
    const c = calendar();
    const row = await c.book({ interventionId: c.job().id });

    await c.world.prisma.appointment.update({ where: { id: row.id }, data: { startsAt: at(9), endsAt: at(11) } });

    expect(c.stored()[0].startsAt).toEqual(at(9));
  });

  it('moving a visit over another is refused, and the visit stays where it was, also inside a transaction that is then undone', async () => {
    const c = calendar();
    const first = await c.book({ interventionId: c.job().id });
    const second = await c.book({ interventionId: c.job().id, startsAt: at(12), endsAt: at(13) });

    const error = await failure(() =>
      c.world.prisma.$transaction(async (tx: any) => {
        await tx.intervention.updateMany({ where: {}, data: { updatedAt: new Date() } });
        await tx.appointment.update({ where: { id: second.id }, data: { startsAt: at(9), endsAt: at(11) } });
      }),
    );

    expect(isOverlapViolation(error)).toBe(true);
    expect(c.stored().find((row) => row.id === second.id).startsAt).toEqual(at(12));
    expect(c.stored().find((row) => row.id === first.id).startsAt).toEqual(at(8));
  });

  it('a cancelled visit cannot be brought back over an hour that was taken meanwhile', async () => {
    const c = calendar();
    const old = await c.book({ interventionId: c.job().id, status: 'CANCELLED' });

    await c.book({ interventionId: c.job().id });

    const error = await failure(() => c.world.prisma.appointment.update({ where: { id: old.id }, data: { status: 'SCHEDULED' } }));

    expect(isOverlapViolation(error)).toBe(true);
    expect(c.stored().find((row) => row.id === old.id).status).toBe('CANCELLED');
  });

  it('a database that was not given the rule does not refuse (the rule is the constraint, not the double)', async () => {
    const memory = new MemoryPrisma();
    const client = memory.plant('user', { role: 'CLIENT' });
    const artisan = memory.plant('user', { role: 'ARTISAN' });
    const job = () => memory.plant('intervention', { clientId: client.id, artisanId: artisan.id });

    memory.plant('appointment', { interventionId: job().id, clientId: client.id, artisanId: artisan.id, status: 'SCHEDULED', startsAt: at(8), endsAt: at(10) });
    memory.plant('appointment', { interventionId: job().id, clientId: client.id, artisanId: artisan.id, status: 'SCHEDULED', startsAt: at(9), endsAt: at(11) });

    expect(memory.rows('appointment')).toHaveLength(2);
  });
});

describe('a booking that slips past the check is a conflict for the person, not an error 500', () => {
  /** The check before a booking looks at the calendar a moment before the write: here it saw nothing. */
  function blind(prisma: any) {
    const blindTx = (tx: any) =>
      new Proxy(tx, {
        get: (target, key) =>
          key === 'appointment'
            ? new Proxy(target.appointment, { get: (appointments, method) => (method === 'count' ? async () => 0 : appointments[method]) })
            : target[key],
      });

    return new Proxy(prisma, {
      get: (target, key) => (key === '$transaction' ? (work: any, options?: any) => target.$transaction((tx: any) => work(blindTx(tx)), options) : target[key]),
    });
  }

  function dispatch(world: World) {
    const m = world.memory;
    const admin = m.plant('user', { role: 'DISPATCHER' });
    const client = m.plant('user', { role: 'CLIENT' });
    const artisan = m.plant('user', { role: 'ARTISAN' });

    m.plant('artisanProfile', { userId: artisan.id, verificationStatus: 'APPROVED', availabilityStatus: 'ONLINE', isAcceptingJobs: true, maxActiveJobs: 10, serviceTypes: ['PLOMBIER'] });

    const busy = m.plant('intervention', { clientId: client.id, artisanId: artisan.id, status: 'ASSIGNED' });
    const free = m.plant('intervention', { clientId: client.id, artisanId: null, status: 'WAITING_ADMIN_REVIEW', urgency: 'NORMAL' });

    m.plant('appointment', { interventionId: busy.id, clientId: client.id, artisanId: artisan.id, status: 'SCHEDULED', startsAt: at(8), endsAt: at(10) });

    return { m, admin, client, artisan, busy, free };
  }

  it('the assignment: 409, and the job keeps its status and its artisan', async () => {
    const world = emptyWorld();
    const d = dispatch(world);
    const assignment = new (world.svc.assignment.constructor as any)(blind(world.prisma), world.svc.told, world.svc.events, world.svc.realtime);

    const error = await failure(() =>
      assignment.assign({ interventionId: d.free.id, artisanId: d.artisan.id, actorId: d.admin.id, startsAt: at(9).toISOString(), endsAt: at(11).toISOString() }),
    );

    expect(error instanceof ConflictException).toBe(true);
    expect(error.message).toBe(OVERLAP_MESSAGE);

    const job = d.m.rows('intervention').find((row: any) => row.id === d.free.id);

    expect(job.status).toBe('WAITING_ADMIN_REVIEW');
    expect(job.artisanId).toBeNull();
    expect(d.m.rows('appointment')).toHaveLength(1);
  });

  it('the same assignment with the check looking properly is refused by the check, before the database', async () => {
    const world = emptyWorld();
    const d = dispatch(world);

    const error = await failure(() =>
      world.svc.assignment.assign({ interventionId: d.free.id, artisanId: d.artisan.id, actorId: d.admin.id, startsAt: at(9).toISOString(), endsAt: at(11).toISOString() }),
    );

    expect(error.getStatus()).toBe(400);
    expect(isOverlapViolation(error)).toBe(false);
  });

  it('a request to move a visit that was approved over a clash the check did not see: 409, the visit and the request stay as they were', async () => {
    const world = emptyWorld();
    const d = dispatch(world);
    const second = d.m.plant('intervention', { clientId: d.client.id, artisanId: d.artisan.id, status: 'ASSIGNED' });
    const moving = d.m.plant('appointment', { interventionId: second.id, clientId: d.client.id, artisanId: d.artisan.id, status: 'RESCHEDULE_REQUESTED', startsAt: at(13), endsAt: at(14) });
    const request = d.m.plant('appointmentRequest', { appointmentId: moving.id, requestedById: d.client.id, type: 'RESCHEDULE', requestedStartAt: at(9), requestedEndAt: at(11), previousStatus: 'SCHEDULED' });

    // The check is blinded: a booking made in the same instant by another route would have looked free to it.
    (world.svc.scheduling as any).checkDoubleBooking = async () => ({ available: true, overlappingAppointments: [], overlappingBlocks: [], withinAvailability: true });

    const error = await failure(() => world.svc.scheduling.reviewAppointmentRequest(d.admin.id, 'DISPATCHER' as any, request.id, true, { adminResponse: 'Ok' } as any));

    expect(error instanceof ConflictException).toBe(true);
    expect(error.message).toBe(OVERLAP_MESSAGE);

    const row = d.m.rows('appointment').find((r: any) => r.id === moving.id);

    expect(row.startsAt).toEqual(at(13));
    expect(row.status).toBe('RESCHEDULE_REQUESTED');
    expect(d.m.rows('appointmentRequest').find((r: any) => r.id === request.id).status).toBe('PENDING');
  });
});

describe('choosing a time writes the visit and the job together (P3-01)', () => {
  function desk() {
    const world = emptyWorld();
    const m = world.memory;
    const client = m.plant('user', { role: 'CLIENT' });
    const artisan = m.plant('user', { role: 'ARTISAN' });
    const job = m.plant('intervention', { clientId: client.id, artisanId: artisan.id, status: 'ASSIGNED', preferredDate: null });
    const choose = () =>
      world.svc.scheduling.choosePreferredTime(client.id, 'CLIENT' as any, job.id, { preferredDate: '2099-10-20', preferredStartTime: '09:00', preferredEndTime: '11:00' } as any);

    return { world, m, job, choose, jobRow: () => m.rows('intervention').find((row: any) => row.id === job.id) };
  }

  async function failure(work: () => Promise<unknown>): Promise<any> {
    try {
      await work();
    } catch (error) {
      return error;
    }

    throw new Error('expected a failure');
  }

  it('when the visit cannot be written the job is not either: the customer\'s choice is all or nothing', async () => {
    const d = desk();

    (d.m as any).failNext('appointment', 'upsert', new Error('the database dropped the connection'));

    const error = await failure(() => d.choose());

    expect(error.message).toContain('dropped');
    expect(d.m.rows('appointment')).toHaveLength(0);
    expect(d.jobRow().preferredDate ?? null).toBeNull();
  });

  it('when the job cannot be written the visit is not either', async () => {
    const d = desk();

    (d.m as any).failNext('intervention', 'update', new Error('the database dropped the connection'));

    const error = await failure(() => d.choose());

    expect(error.message).toContain('dropped');
    expect(d.m.rows('appointment')).toHaveLength(0);
  });

  it('both are written when nothing fails', async () => {
    const d = desk();

    await d.choose();

    expect(d.m.rows('appointment')).toHaveLength(1);
    expect(d.jobRow().preferredStartTime).toBe('09:00');
  });
});

describe('the script that creates the constraint', () => {
  function fakeDb(options: { present?: boolean; visits?: any[]; noExtension?: boolean } = {}) {
    const run: string[] = [];
    const queries: string[] = [];

    return {
      run,
      queries,
      db: {
        $queryRawUnsafe: async (sql: string) => {
          queries.push(sql);

          if (sql.includes('pg_constraint')) return options.present ? [{ '?column?': 1 }] : [];
          if (sql.includes('pg_available_extensions')) return options.noExtension ? [] : [{ '?column?': 1 }];

          return options.visits ?? [];
        },
        $executeRawUnsafe: async (sql: string) => {
          run.push(sql);

          return 0;
        },
      },
    };
  }

  const row = (id: number, data: Record<string, any> = {}) => ({ id, artisanId: 4, startsAt: at(8), endsAt: at(10), status: 'SCHEDULED', ...data });

  it('does nothing on a database that has the constraint already, even with --apply', async () => {
    const f = fakeDb({ present: true });
    const report = await ensureOverlapConstraint({ db: f.db, apply: true });

    expect(report).toEqual({ present: true, clashes: [], applied: false, ok: true });
    expect(f.run).toEqual([]);
    expect(f.queries).toHaveLength(1);
  });

  it('a dry run looks and writes nothing, and says it is ready', async () => {
    const f = fakeDb({ visits: [row(1), row(2, { startsAt: at(10), endsAt: at(11) })] });
    const lines: string[] = [];
    const report = await ensureOverlapConstraint({ db: f.db, apply: false, log: (line) => lines.push(line) });

    expect(report).toEqual({ present: false, clashes: [], applied: false, ok: true });
    expect(f.run).toEqual([]);
    expect(lines.join('\n')).toContain('--apply');
  });

  it('visits that overlap already: lists them, writes nothing, even with --apply, and is not ok (exit code 1)', async () => {
    const f = fakeDb({ visits: [row(1), row(2, { startsAt: at(9), endsAt: at(11) }), row(3, { artisanId: 9 })] });
    const lines: string[] = [];
    const report = await ensureOverlapConstraint({ db: f.db, apply: true, log: (line) => lines.push(line) });

    expect(report.ok).toBe(false);
    expect(report.applied).toBe(false);
    expect(report.clashes.map(([a, b]) => [a.id, b.id])).toEqual([[1, 2]]);
    expect(f.run).toEqual([]);
    expect(lines.join('\n')).toContain('appointment #1');
    expect(lines.join('\n')).toContain('#2');
  });

  it('says what the job of each visit is, and that a visit that took place is marked COMPLETED, not cancelled', async () => {
    const f = fakeDb({ visits: [row(1, { interventionId: 11 }), row(2, { interventionId: 12, startsAt: at(9), endsAt: at(11) }), row(3, { interventionId: 13, artisanId: 9 })] });
    const lines: string[] = [];
    const asked: number[][] = [];
    const report = await ensureOverlapConstraint({
      db: f.db,
      apply: false,
      log: (line) => lines.push(line),
      jobStatuses: async (ids) => {
        asked.push(ids);

        return new Map([[11, 'PAID'], [12, 'ASSIGNED'], [13, 'CREATED']]);
      },
    });
    const text = lines.join('\n');

    expect(report.clashes[0][0].jobStatus).toBe('PAID');
    expect(report.clashes[0][1].jobStatus).toBe('ASSIGNED');
    expect(text).toContain('job PAID');
    expect(text).toContain('job ASSIGNED');
    expect(text).toContain('COMPLETED');
    expect(text).toMatch(/not to be cancelled/);
    // only the jobs of the visits that clash are asked for
    expect(asked).toEqual([[11, 12]]);
  });

  it('a job that is not found, or a script that cannot say, prints a question mark and still lists the clash', async () => {
    const f = fakeDb({ visits: [row(1, { interventionId: 11 }), row(2, { interventionId: 12, startsAt: at(9), endsAt: at(11) })] });
    const lines: string[] = [];
    const report = await ensureOverlapConstraint({ db: f.db, apply: false, log: (line) => lines.push(line), jobStatuses: async () => new Map([[11, 'PAID']]) });

    expect(report.ok).toBe(false);
    expect(lines.join('\n')).toContain('job PAID');
    expect(lines.join('\n')).toContain('job ?');

    const bare = await ensureOverlapConstraint({ db: fakeDb({ visits: [row(1), row(2, { startsAt: at(9), endsAt: at(11) })] }).db, apply: false });

    expect(bare.ok).toBe(false);
  });

  it('no job is asked for when nothing clashes', async () => {
    const f = fakeDb({ visits: [row(1, { interventionId: 11 })] });
    let asked = 0;

    await ensureOverlapConstraint({ db: f.db, apply: false, jobStatuses: async () => { asked += 1; return new Map(); } });

    expect(asked).toBe(0);
  });

  it('never reads the job\'s table with raw SQL (the status of a job is only written by the workflow, and a test forbids raw SQL on it)', async () => {
    const f = fakeDb({ visits: [row(1, { interventionId: 11 }), row(2, { interventionId: 12, startsAt: at(9), endsAt: at(11) })] });

    await ensureOverlapConstraint({ db: f.db, apply: false, jobStatuses: async () => new Map() });

    for (const sql of f.queries) expect(sql).not.toContain('"Intervention"');

    expect(f.queries.find((sql) => sql.includes('"Appointment"'))).toContain('a."interventionId"');
  });

  it('with --apply and nothing in the way: creates the extension, then the constraint, in that order', async () => {
    const f = fakeDb({ visits: [row(1)] });
    const report = await ensureOverlapConstraint({ db: f.db, apply: true });

    expect(report).toEqual({ present: false, clashes: [], applied: true, ok: true });
    expect(f.run).toEqual(overlapConstraintStatements());
  });

  describe('visits that still stand on a cancelled job (a cancellation that did not free them)', () => {
    const clashing = () => [row(1, { interventionId: 11 }), row(2, { interventionId: 12, startsAt: at(9), endsAt: at(11) })];

    it('a dry run says how many there are, writes nothing, and does not count them as overlaps', async () => {
      const f = fakeDb({ visits: clashing() });
      const lines: string[] = [];
      const released: number[][] = [];
      const report = await ensureOverlapConstraint({
        db: f.db,
        apply: false,
        log: (line) => lines.push(line),
        visitsOfCancelledJobs: { find: async () => [12], release: async (ids) => { released.push(ids); } },
      });

      expect(released).toEqual([]);
      expect(f.run).toEqual([]);
      expect(report).toEqual({ present: false, clashes: [], applied: false, ok: true, standing: 1 });
      expect(lines.join('\n')).toContain('1 visit(s) still stand on a cancelled job (job #12)');
      expect(lines.join('\n')).toContain('--apply');
    });

    it('with --apply they are cancelled first, then the constraint is created', async () => {
      const f = fakeDb({ visits: clashing() });
      const order: string[] = [];
      const db: any = {
        ...f.db,
        $executeRawUnsafe: async (sql: string) => {
          order.push('constraint');

          return f.db.$executeRawUnsafe(sql);
        },
      };
      const report = await ensureOverlapConstraint({
        db,
        apply: true,
        visitsOfCancelledJobs: { find: async () => [11, 12], release: async (ids) => { order.push(`release ${ids.join(',')}`); } },
      });

      expect(order[0]).toBe('release 11,12');
      expect(order.slice(1).every((entry) => entry === 'constraint')).toBe(true);
      expect(report).toMatchObject({ applied: true, ok: true, standing: 2, released: 2 });
    });

    it('a release that fails stops the run: the constraint is not created', async () => {
      const f = fakeDb({ visits: [row(1)] });
      let error: any = null;

      try {
        await ensureOverlapConstraint({
          db: f.db,
          apply: true,
          visitsOfCancelledJobs: { find: async () => [11], release: async () => { throw new Error('the database dropped the connection'); } },
        });
      } catch (caught) {
        error = caught;
      }

      expect(error?.message).toContain('dropped');
      expect(f.run).toEqual([]);
    });

    it('a visit that really overlaps another one is still reported, whatever stands on cancelled jobs elsewhere', async () => {
      const f = fakeDb({ visits: [...clashing(), row(3, { interventionId: 13, artisanId: 9 })] });
      const report = await ensureOverlapConstraint({ db: f.db, apply: false, visitsOfCancelledJobs: { find: async () => [13], release: async () => undefined } });

      expect(report.clashes).toHaveLength(1);
      expect(report.ok).toBe(false);
      expect(report.standing).toBe(1);
    });

    it('nothing standing: the report is what it was, and the callbacks are not asked to release', async () => {
      const f = fakeDb({ visits: [row(1)] });
      let released = 0;
      const report = await ensureOverlapConstraint({ db: f.db, apply: true, visitsOfCancelledJobs: { find: async () => [], release: async () => { released += 1; } } });

      expect(report).toEqual({ present: false, clashes: [], applied: true, ok: true });
      expect(released).toBe(0);
    });

    it('a database that already has the constraint is not asked anything', async () => {
      const f = fakeDb({ present: true });
      let asked = 0;

      await ensureOverlapConstraint({ db: f.db, apply: true, visitsOfCancelledJobs: { find: async () => { asked += 1; return [1]; }, release: async () => undefined } });

      expect(asked).toBe(0);
    });
  });

  it('a database that does not offer btree_gist cannot have the constraint: the dry run and --apply both say so, write nothing, and are not ok', async () => {
    for (const apply of [false, true]) {
      const f = fakeDb({ visits: [row(1)], noExtension: true });
      const lines: string[] = [];
      const report = await ensureOverlapConstraint({ db: f.db, apply, log: (line) => lines.push(line) });

      expect(report).toEqual({ present: false, clashes: [], applied: false, ok: false, missingExtension: true });
      expect(f.run).toEqual([]);
      expect(lines.join('\n')).toContain('btree_gist');
    }
  });

  it('visits that overlap are reported first, whatever the extension', async () => {
    const f = fakeDb({ visits: [row(1), row(2, { startsAt: at(9), endsAt: at(11) })], noExtension: true });
    const report = await ensureOverlapConstraint({ db: f.db, apply: false });

    expect(report.clashes).toHaveLength(1);
    expect(report.missingExtension).toBeUndefined();
  });

  it('only looks at the visits that hold the calendar (the query names the same states as the constraint)', async () => {
    const f = fakeDb();

    await ensureOverlapConstraint({ db: f.db, apply: false });

    const visits = f.queries.find((sql) => sql.includes('"Appointment"')) as string;

    for (const status of ACTIVE_APPOINTMENT_STATUSES) expect(visits).toContain(`'${status}'`);

    expect(visits).not.toContain("'CANCELLED'");
  });
});
