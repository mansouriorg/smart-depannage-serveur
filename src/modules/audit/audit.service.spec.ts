import { BadRequestException } from '@nestjs/common';

import { emptyWorld } from '../../common/testing/world';
import { AuditOutcome } from './audit-outcome';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, parseAuditQuery } from './audit-query';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

/** The filter as plain data: the fields that were not given are not there. */
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

/** Whether a call is refused with a 400. */
function refused(call: () => unknown): boolean {
  try {
    call();
  } catch (error) {
    return error instanceof BadRequestException;
  }

  return false;
}

/** Reading the audit log (P3-02): the filters, the pages, and the query string that feeds them. */

function setup() {
  const world = emptyWorld();
  const m = world.memory;
  const amel = m.plant('user', { role: 'ADMIN', name: 'Amel' });
  const sami = m.plant('user', { role: 'SUPPORT', name: 'Sami' });
  const service = new AuditService(world.prisma);
  const day = (n: number, hour = 9) => new Date(Date.UTC(2026, 9, n, hour));

  const log = (actor: Record<string, any>, action: string, extra: Record<string, unknown> = {}) =>
    m.plant('auditLog', { actorId: actor.id, actorRole: actor.role, action, routeKey: 'POST /x', outcome: 'SUCCEEDED', statusCode: 200, changedFields: [], createdAt: day(20), ...extra });

  return { world, m, amel, sami, service, day, log };
}

describe('reading the audit log', () => {
  it('answers the newest first, with who did it and what it was done to', async () => {
    const { service, amel, sami, log, day } = setup();

    log(amel, 'users.update', { targetType: 'User', targetId: '42', changedFields: ['role'], details: { role: 'SUPPORT' }, createdAt: day(20), finishedAt: day(20) });
    log(sami, 'payments.refund', { targetType: 'Payment', targetId: '7', createdAt: day(21) });

    const page = await service.list({ limit: 10 });

    expect(page.items.map((item) => item.action)).toEqual(['payments.refund', 'users.update']);
    expect(page.items[0]).toMatchObject({ actor: { id: sami.id, role: 'SUPPORT', name: 'Sami' }, target: { type: 'Payment', id: '7' }, outcome: 'SUCCEEDED' });
    expect(page.items[1]).toMatchObject({ actor: { id: amel.id, name: 'Amel' }, changedFields: ['role'], details: { role: 'SUPPORT' } });
    expect(page.nextBefore).toBeNull();
  });

  it('keeps the row of an account that is gone: the name is empty, the id and role stay', async () => {
    const { service, m, log } = setup();

    log({ id: 9999, role: 'DISPATCHER' }, 'interventions.cancel');

    const page = await service.list({ limit: 10 });

    expect(page.items[0].actor).toEqual({ id: 9999, role: 'DISPATCHER', name: null });
    expect(m.rows('auditLog')).toHaveLength(1);
  });

  it('says nothing about the target when the action had none', async () => {
    const { service, amel, log } = setup();

    log(amel, 'settings.update-company');

    expect((await service.list({ limit: 10 })).items[0].target).toBeNull();
  });

  it('never returns a field the log does not keep: no address, no body', async () => {
    const { service, amel, log } = setup();

    log(amel, 'users.update', { targetType: 'User', targetId: '1' });

    const item = (await service.list({ limit: 10 })).items[0] as Record<string, unknown>;

    expect(Object.keys(item).sort()).toEqual(['action', 'actor', 'changedFields', 'createdAt', 'details', 'finishedAt', 'id', 'outcome', 'routeKey', 'statusCode', 'target']);
  });

  it('filters by who, what, on what, how it went and when', async () => {
    const { service, amel, sami, log, day } = setup();

    log(amel, 'users.update', { targetType: 'User', targetId: '42', createdAt: day(10) });
    log(amel, 'users.deactivate', { targetType: 'User', targetId: '43', createdAt: day(12) });
    log(sami, 'payments.refund', { targetType: 'Payment', targetId: '42', outcome: 'FAILED', statusCode: 409, createdAt: day(14) });
    log(sami, 'payments.confirm', { targetType: 'Payment', targetId: '8', createdAt: day(16) });

    const names = async (filter: Record<string, unknown>) => (await service.list({ limit: 50, ...filter })).items.map((item) => item.action).sort();

    expect(await names({ actorId: amel.id })).toEqual(['users.deactivate', 'users.update']);
    expect(await names({ action: 'payments.refund' })).toEqual(['payments.refund']);
    expect(await names({ action: 'payments.' })).toEqual(['payments.confirm', 'payments.refund']);
    expect(await names({ action: 'payments' })).toEqual([]);
    expect(await names({ targetType: 'User' })).toEqual(['users.deactivate', 'users.update']);
    expect(await names({ targetType: 'Payment', targetId: '42' })).toEqual(['payments.refund']);
    expect(await names({ outcome: AuditOutcome.FAILED })).toEqual(['payments.refund']);
    expect(await names({ from: day(12), to: day(14, 23) })).toEqual(['payments.refund', 'users.deactivate']);
    expect(await names({ from: day(15) })).toEqual(['payments.confirm']);
    expect(await names({ to: day(11) })).toEqual(['users.update']);
    expect(await names({ actorId: sami.id, action: 'users.' })).toEqual([]);
  });

  it('a period includes both of its ends, to the millisecond', async () => {
    const { service, amel, log, day } = setup();

    log(amel, 'payments.refund', { createdAt: day(12) });
    log(amel, 'payments.confirm', { createdAt: day(13) });
    log(amel, 'payments.fail', { createdAt: day(14) });

    expect((await service.list({ from: day(13), to: day(13), limit: 50 })).items.map((item) => item.action)).toEqual(['payments.confirm']);
    expect((await service.list({ from: day(13), limit: 50 })).items.map((item) => item.action)).toEqual(['payments.fail', 'payments.confirm']);
    expect((await service.list({ to: day(13), limit: 50 })).items.map((item) => item.action)).toEqual(['payments.confirm', 'payments.refund']);
  });

  it('writes the start of a row with the clock of the server, the same one that writes its end', async () => {
    const { world, service, amel, m } = setup();
    const before = Date.now();
    const create = world.prisma.auditLog.create.bind(world.prisma.auditLog);
    let written: { data: Record<string, unknown> } | undefined;

    world.prisma.auditLog.create = (args: { data: Record<string, unknown> }) => {
      written = args;

      return create(args);
    };

    const id = await service.begin({ actorId: amel.id, actorRole: 'ADMIN' as any, action: 'payments.refund', routeKey: 'PATCH /payments/:/refund', targetType: 'Payment', targetId: '5' });

    await service.finish(id, { outcome: 'SUCCEEDED' as any, statusCode: 200, changedFields: [], details: null });

    const row = m.rows('auditLog').find((r: any) => r.id === id);

    // the service gives the time itself; it does not leave it to the database's default
    expect(written?.data.createdAt).toBeInstanceOf(Date);
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(row.finishedAt.getTime()).toBeGreaterThanOrEqual(row.createdAt.getTime());
  });

  it('reads it page by page: the cursor is the id of the last row, and the end says null', async () => {
    const { service, amel, log } = setup();

    for (let i = 1; i <= 5; i += 1) log(amel, `things.step-${i}`);

    const first = await service.list({ limit: 2 });
    const second = await service.list({ limit: 2, before: first.nextBefore as number });
    const third = await service.list({ limit: 2, before: second.nextBefore as number });

    expect(first.items.map((item) => item.action)).toEqual(['things.step-5', 'things.step-4']);
    expect(second.items.map((item) => item.action)).toEqual(['things.step-3', 'things.step-2']);
    expect(third.items.map((item) => item.action)).toEqual(['things.step-1']);
    expect([first.nextBefore !== null, second.nextBefore !== null, third.nextBefore]).toEqual([true, true, null]);
  });

  it('a page that ends exactly at the last row has no next page', async () => {
    const { service, amel, log } = setup();

    log(amel, 'a.b');
    log(amel, 'a.c');

    expect((await service.list({ limit: 2 })).nextBefore).toBeNull();
  });

  it('shows a row that is still STARTED (an action that never came back) like any other', async () => {
    const { service, amel, log } = setup();

    log(amel, 'payments.refund', { outcome: 'STARTED', statusCode: null, finishedAt: null });

    expect((await service.list({ limit: 5 })).items[0]).toMatchObject({ outcome: 'STARTED', statusCode: null, finishedAt: null });
  });
});

describe('the query string of the log', () => {
  it('has defaults', () => {
    expect(plain(parseAuditQuery(undefined))).toEqual({ limit: DEFAULT_PAGE_SIZE });
    expect(parseAuditQuery({})).toMatchObject({ limit: DEFAULT_PAGE_SIZE });
    expect(DEFAULT_PAGE_SIZE).toBe(50);
    expect(MAX_PAGE_SIZE).toBe(200);
  });

  it('reads every filter', () => {
    const filter = parseAuditQuery({ actorId: '3', action: 'users.', targetType: 'User', targetId: '42', outcome: 'FAILED', from: '2026-10-01', to: '2026-10-31T10:00:00Z', before: '900', limit: '25' });

    expect(filter).toMatchObject({ actorId: 3, action: 'users.', targetType: 'User', targetId: '42', outcome: 'FAILED', before: 900, limit: 25 });
    expect(filter.from?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(filter.to?.toISOString()).toBe('2026-10-31T10:00:00.000Z');
  });

  it('treats an empty value as absent', () => {
    expect(plain(parseAuditQuery({ actorId: '', action: '  ', outcome: '' }))).toEqual({ limit: DEFAULT_PAGE_SIZE });
  });

  it('refuses a wrong value with a 400 instead of ignoring it', () => {
    const wrong: Array<Record<string, unknown>> = [
      { actorId: 'abc' },
      { actorId: '-1' },
      { actorId: '0' },
      { actorId: '1.5' },
      { actorId: '99999999999' },
      { limit: '0' },
      { limit: '201' },
      { limit: 'ten' },
      { before: '0' },
      { outcome: 'DONE' },
      { outcome: 'succeeded' },
      { action: 'Users.Update' },
      { action: 'users.update; drop table' },
      { action: '.x' },
      { targetType: 'a b' },
      { targetId: 'x'.repeat(65) },
      { from: 'yesterday' },
      { from: '12' },
      { to: '2026-13-45' },
      { from: '2026-10-31', to: '2026-10-01' },
      { from: '2026-02-31' },
      { to: '2026-04-31' },
      { from: '2027-02-29' },
      { from: '2026-10-31T10:00:00' },
      { to: '2026-10-31T10:00' },
      { from: '2026-10-31T25:00:00Z' },
      { from: '2026-10-31T24:00:00Z' },
      { to: '2026-10-31T10:00:60Z' },
      { from: '2026-10-31T10:61:00Z' },
      { from: '2026-10-31 10:00:00Z' },
      { from: '2026-10-31T10:00:00+0100' },
      { action: ['a.b', 'c.d'] },
      { actor: '3' },
      { limite: '10' },
      { action: 'payments.', extra: 'x' },
      { __proto__x: '1' },
      { actorId: { gt: 1 } },
    ];

    for (const query of wrong) expect([JSON.stringify(query), refused(() => parseAuditQuery(query))]).toEqual([JSON.stringify(query), true]);
  });

  it('a day without an hour means the whole day, in UTC: `to` includes its last millisecond', () => {
    const filter = parseAuditQuery({ from: '2026-10-31', to: '2026-10-31' });

    expect(filter.from?.toISOString()).toBe('2026-10-31T00:00:00.000Z');
    expect(filter.to?.toISOString()).toBe('2026-10-31T23:59:59.999Z');
    expect(parseAuditQuery({ to: '2024-02-29' }).to?.toISOString()).toBe('2024-02-29T23:59:59.999Z');
  });

  it('a date with an hour needs its zone, and keeps the instant it names', () => {
    expect(parseAuditQuery({ from: '2026-10-31T10:00:00Z' }).from?.toISOString()).toBe('2026-10-31T10:00:00.000Z');
    expect(parseAuditQuery({ from: '2026-10-31T10:00:00+01:00' }).from?.toISOString()).toBe('2026-10-31T09:00:00.000Z');
    expect(parseAuditQuery({ to: '2026-10-31T10:00Z' }).to?.toISOString()).toBe('2026-10-31T10:00:00.000Z');
    expect(parseAuditQuery({ to: '2026-10-31T10:00:00.250-02:00' }).to?.toISOString()).toBe('2026-10-31T12:00:00.250Z');
  });

  it('a request for a whole day finds a row written at the end of that day', async () => {
    const { world, amel, log } = setup();

    log(amel, 'payments.refund', { createdAt: new Date('2026-10-31T23:30:00Z') });
    log(amel, 'payments.confirm', { createdAt: new Date('2026-11-01T00:00:00Z') });

    const found = await new AuditService(world.prisma).list(parseAuditQuery({ from: '2026-10-31', to: '2026-10-31' }));

    expect(found.items.map((item) => item.action)).toEqual(['payments.refund']);
  });

  it('writes the id it looks for the way the log writes it', () => {
    expect(parseAuditQuery({ targetId: '0042' }).targetId).toBe('42');
    expect(parseAuditQuery({ targetId: '42' }).targetId).toBe('42');
    expect(parseAuditQuery({ targetId: 'abc-1' }).targetId).toBe('abc-1');
  });

  it('takes the largest page it allows', () => {
    expect(parseAuditQuery({ limit: '200' }).limit).toBe(200);
    expect(parseAuditQuery({ limit: '1' }).limit).toBe(1);
  });
});

describe('the route of the log', () => {
  it('reads the log with the filters of the query string', async () => {
    const { world, amel, log } = setup();
    const controller = new AuditController(new AuditService(world.prisma));

    log(amel, 'users.update');
    log(amel, 'payments.refund');

    expect((await controller.list({ action: 'payments.' })).items.map((item) => item.action)).toEqual(['payments.refund']);
    expect((await controller.list({})).items).toHaveLength(2);
  });

  it('refuses a query that is wrong before it reaches the database', async () => {
    const { world } = setup();
    const controller = new AuditController(new AuditService(world.prisma));

    expect(refused(() => controller.list({ limit: '9999' }))).toBe(true);
  });
});
