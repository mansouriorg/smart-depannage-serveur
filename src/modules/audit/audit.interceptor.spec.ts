import { CallHandler, ExecutionContext, ForbiddenException, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { EMPTY, concat, from, lastValueFrom, of, throwError } from 'rxjs';

import { emptyWorld } from '../../common/testing/world';
import { AUDITED_ROUTES, NOT_AUDITED_ROUTES } from './audit-actions';
import { AuditInterceptor } from './audit.interceptor';
import { AuditService } from './audit.service';

/**
 * The audit interceptor (P3-02), driven the way Nest drives it: a request with a person on it, a handler, an answer or an error.
 * The database is the in-memory one, whose shape is read from prisma/schema.prisma.
 */

/** Runs a test with the logger's errors counted instead of printed, and puts the real logger back even when the test fails. */
async function quietly(run: (told: unknown[]) => Promise<void>): Promise<void> {
  const original = Logger.prototype.error;
  const told: unknown[] = [];

  Logger.prototype.error = ((message: unknown) => {
    told.push(message);
  }) as typeof Logger.prototype.error;

  try {
    await run(told);
  } finally {
    Logger.prototype.error = original;
  }
}

function setup() {
  const world = emptyWorld();
  const m = world.memory;
  const admin = m.plant('user', { role: 'ADMIN', name: 'Amel' });
  const interceptor = new AuditInterceptor(new AuditService(world.prisma));
  const rows = () => m.rows('auditLog');

  return { world, m, admin, interceptor, rows };
}

/** The response Nest hands over: its status is already set when the interceptors run (`@HttpCode`, else 201 for a POST and 200 for the rest). */
function contextOf(request: Record<string, unknown>, statusCode?: number, type = 'http'): ExecutionContext {
  const response = { statusCode: statusCode ?? (String(request.method).toUpperCase() === 'POST' ? 201 : 200) };

  return { getType: () => type, switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }), getHandler: () => function handle() {} } as unknown as ExecutionContext;
}

const handling = (run: () => unknown): CallHandler => ({ handle: () => from(Promise.resolve().then(run)) });

async function call(interceptor: AuditInterceptor, request: Record<string, unknown>, run: () => unknown, statusCode?: number) {
  const stream = await interceptor.intercept(contextOf(request, statusCode), handling(run));

  return lastValueFrom(stream);
}

const patchUser = (admin: Record<string, any>, overrides: Record<string, unknown> = {}) => ({
  method: 'PATCH',
  route: { path: '/api/users/:id' },
  params: { id: '42' },
  body: { role: 'SUPPORT', isActive: true, name: 'Nouveau nom' },
  user: { id: admin.id, role: 'ADMIN' },
  ...overrides,
});

describe('every write of the back office leaves a row (P3-02)', () => {
  describe('an action that works', () => {
    it('writes the row before the action runs, and closes it after', async () => {
      const { interceptor, admin, rows } = setup();
      let seenWhileRunning: Record<string, unknown> | undefined;

      const answer = await call(interceptor, patchUser(admin), () => {
        seenWhileRunning = { ...rows()[0] };

        return { id: 42, ok: true };
      });

      expect(answer).toEqual({ id: 42, ok: true });
      expect(seenWhileRunning).toMatchObject({ outcome: 'STARTED', actorId: admin.id, actorRole: 'ADMIN', action: 'users.update', routeKey: 'PATCH /users/:', targetType: 'User', targetId: '42' });
      expect(seenWhileRunning?.finishedAt ?? null).toBeNull();
      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({ outcome: 'SUCCEEDED', statusCode: 200, targetId: '42' });
      expect(rows()[0].finishedAt).toBeInstanceOf(Date);
      expect(rows()[0].createdAt).toBeInstanceOf(Date);
    });

    it('keeps the names of the fields sent and the values the action allows', async () => {
      const { interceptor, admin, rows } = setup();

      await call(interceptor, patchUser(admin), () => ({ id: 42 }));

      expect(rows()[0].changedFields).toEqual(['role', 'isActive', 'name']);
      expect(rows()[0].details).toEqual({ role: 'SUPPORT', isActive: true });
      expect(JSON.stringify(rows()[0])).not.toContain('Nouveau nom');
    });

    it('reads the body after the handler has run: an upload is parsed by a later interceptor', async () => {
      const { interceptor, admin, rows } = setup();
      const request: Record<string, unknown> = {
        method: 'POST',
        route: { path: '/api/files/artisan/identity' },
        params: {},
        user: { id: admin.id, role: 'ADMIN' },
      };

      await call(interceptor, request, () => {
        expect(rows()[0].changedFields).toEqual([]);
        request.body = { label: 'passeport' };
        request.file = { originalname: 'p.png' };

        return { asset: { id: 77 }, document: { id: 5 } };
      });

      expect(rows()[0]).toMatchObject({ action: 'files.upload-identity', outcome: 'SUCCEEDED', statusCode: 201, targetId: '77', targetType: 'File' });
      expect(rows()[0].changedFields).toEqual(['label', 'file']);
    });

    it('takes the id of what was created from the answer', async () => {
      const { interceptor, admin, rows } = setup();

      await call(interceptor, { method: 'POST', route: { path: '/api/users' }, params: {}, body: { email: 'x@y.tn', password: 'Secret-123', role: 'SUPPORT' }, user: { id: admin.id, role: 'ADMIN' } }, () => ({ id: 91, email: 'x@y.tn' }));

      expect(rows()[0]).toMatchObject({ action: 'users.create', targetType: 'User', targetId: '91', statusCode: 201 });
      expect(rows()[0].details).toEqual({ role: 'SUPPORT' });
      expect(JSON.stringify(rows()[0])).not.toContain('Secret-123');
    });

    it('records the status the response has when the handler answers (the one `@HttpCode` gave it)', async () => {
      const { interceptor, admin, rows } = setup();

      await call(interceptor, patchUser(admin), () => undefined, 204);

      expect(rows()[0].statusCode).toBe(204);
    });

    it('says 201 for a POST and 200 for the others when the response carries no usable status', async () => {
      const { interceptor, admin, rows } = setup();
      const bare = (request: Record<string, unknown>) => ({ getType: () => 'http', switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ statusCode: 'x' }) }), getHandler: () => function handle() {} }) as unknown as ExecutionContext;

      await lastValueFrom(await interceptor.intercept(bare(patchUser(admin)), handling(() => 'a')));
      await lastValueFrom(await interceptor.intercept(bare(patchUser(admin, { method: 'POST', route: { path: '/api/users' }, params: {} })), handling(() => ({ id: 3 }))));

      expect(rows().map((row: any) => row.statusCode)).toEqual([200, 201]);
    });

    it('reads the id of what was created at the path the list of actions names, and nowhere else', async () => {
      const { interceptor, admin, rows } = setup();
      const artisan = { method: 'POST', route: { path: '/api/admin/artisans' }, params: {}, body: { name: 'Ali' }, user: { id: admin.id, role: 'ADMIN' } };

      await call(interceptor, artisan, () => ({ profile: { id: 31 }, user: { id: 8 }, id: 99 }));
      await call(interceptor, artisan, () => ({ id: 99, user: { id: 8 } }));
      await call(interceptor, artisan, () => 'created');

      expect(rows().map((row: any) => [row.targetType, row.targetId])).toEqual([['ArtisanProfile', '31'], ['ArtisanProfile', null], ['ArtisanProfile', null]]);
    });

    it('writes an id without leading zeros, and no id at all for a text that is not one', async () => {
      const { interceptor, admin, rows } = setup();

      // `0x2A`, `1e1` and `42.0` are how a route that reads its id with a unary plus reaches 42, 10 and 42: none of them is written as an id
      const loose = ['0x2A', '1e1', '0b101', '42e0', '42.0', ' 42', '%2042', 'approved-by-ceo', '42abc'];

      for (const id of ['0000042', '42', ...loose, '../etc/passwd', '42\u0000', '4 2', '', '0', 'x'.repeat(65)]) {
        await call(interceptor, patchUser(admin, { params: { id } }), () => 'done');
      }

      expect(rows().map((row: any) => row.targetId)).toEqual(['42', '42', ...loose.map(() => null), null, null, null, null, null, null]);
    });

    it('does not read the query string or the headers: the log keeps no address, no body, no token', async () => {
      const { interceptor, admin, rows } = setup();

      await call(
        interceptor,
        { method: 'PATCH', route: { path: '/api/payments/:paymentId/refund' }, params: { paymentId: '5' }, body: {}, query: { reason: 'from the query', amount: '5' }, headers: { authorization: 'Bearer abc', 'x-forwarded-for': '10.0.0.9' }, ip: '10.0.0.9', user: { id: admin.id, role: 'ADMIN' } },
        () => 'done',
      );

      expect(rows()[0].details ?? null).toBeNull();
      expect(rows()[0].changedFields).toEqual([]);
      expect(JSON.stringify(rows())).not.toMatch(/Bearer|10\.0\.0\.9|from the query/);
    });

    it('a reason with half an emoji, or cut in the middle of one, is kept whole and the row is closed', async () => {
      const { interceptor, admin, rows } = setup();
      const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
      const refund = (reason: string) => ({ method: 'PATCH', route: { path: '/api/payments/:paymentId/refund' }, params: { paymentId: '5' }, body: { amount: 10, reason }, user: { id: admin.id, role: 'ADMIN' } });

      await call(interceptor, refund('\ud800'), () => 'done');
      await call(interceptor, refund(`${'a'.repeat(197)}\ud83d\ude00${'b'.repeat(30)}`), () => 'done');
      await call(interceptor, refund('Doublon \ud83d\ude00 payé deux fois'), () => 'done');

      expect(rows().map((row: any) => row.outcome)).toEqual(['SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED']);
      expect(rows().map((row: any) => lone.test(String(row.details?.reason ?? '')))).toEqual([false, false, false]);
      expect(rows()[0].details).toEqual({ amount: 10 });
      expect(rows()[2].details.reason).toBe('Doublon \ud83d\ude00 payé deux fois');
    });

    it('keeps a reason without its control characters, and nothing else a person typed', async () => {
      const { interceptor, admin, rows } = setup();

      await call(interceptor, { method: 'PATCH', route: { path: '/api/payments/:paymentId/refund' }, params: { paymentId: '5' }, body: { amount: 10, reason: 'Doublon\u0000\n\u2028ligne', note: 'secret' }, user: { id: admin.id, role: 'ADMIN' } }, () => 'done');

      expect(rows()[0]).toMatchObject({ action: 'payments.refund', targetType: 'Payment', targetId: '5' });
      expect(rows()[0].details).toEqual({ amount: 10, reason: 'Doublon ligne' });
      expect(rows()[0].changedFields).toEqual(['amount', 'reason', 'note']);
    });

    it('the target of an action on the own account is the person', async () => {
      const { interceptor, admin, rows } = setup();

      await call(interceptor, { method: 'POST', route: { path: '/api/auth/change-password' }, params: {}, body: { currentPassword: 'Old-secret-1', newPassword: 'New-secret-2' }, user: { id: admin.id, role: 'ADMIN' } }, () => ({ ok: true }));

      expect(rows()[0]).toMatchObject({ action: 'auth.change-password', targetType: 'User', targetId: String(admin.id) });
      expect(rows()[0].changedFields).toEqual(['currentPassword', 'newPassword']);
      expect(JSON.stringify(rows())).not.toMatch(/Old-secret|New-secret/);
    });

    it('keeps the parameter of the path as a detail when the action asks for it', async () => {
      const { interceptor, admin, rows } = setup();

      await call(interceptor, { method: 'POST', route: { path: '/api/matching/admin/interventions/:interventionId/assign/:artisanId' }, params: { interventionId: '5', artisanId: '9' }, body: {}, user: { id: admin.id, role: 'DISPATCHER' } }, () => ({ ok: true }));

      expect(rows()[0]).toMatchObject({ action: 'interventions.assign-artisan', actorRole: 'DISPATCHER', targetId: '5' });
      expect(rows()[0].details).toEqual({ artisanId: 9 });
    });
  });

  describe('an action that fails', () => {
    it('closes the row as FAILED with the status of the error, and passes the error on', async () => {
      const { interceptor, admin, rows } = setup();

      await expect(call(interceptor, patchUser(admin), () => { throw new NotFoundException('Compte introuvable.'); })).rejects.toBeInstanceOf(NotFoundException);

      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({ outcome: 'FAILED', statusCode: 404, targetId: '42' });
      expect(rows()[0].finishedAt).toBeInstanceOf(Date);
    });

    it('says 500 for an error that is not an HTTP one', async () => {
      const { interceptor, admin, rows } = setup();

      await expect(call(interceptor, patchUser(admin), () => { throw new Error('boom'); })).rejects.toThrow('boom');

      expect(rows()[0]).toMatchObject({ outcome: 'FAILED', statusCode: 500 });
    });

    it('does not keep the id of something that was not created', async () => {
      const { interceptor, admin, rows } = setup();

      await expect(call(interceptor, { method: 'POST', route: { path: '/api/users' }, params: {}, body: { email: 'a@b.tn' }, user: { id: admin.id, role: 'ADMIN' } }, () => { throw new ForbiddenException(); })).rejects.toBeInstanceOf(ForbiddenException);

      expect(rows()[0]).toMatchObject({ outcome: 'FAILED', statusCode: 403, targetId: null });
    });
  });

  describe('who and what is logged', () => {
    it.each(['CLIENT', 'ARTISAN'])('a %s who calls the same route leaves nothing', async (role) => {
      const { interceptor, admin, rows } = setup();
      let ran = 0;

      await call(interceptor, patchUser(admin, { user: { id: 999, role } }), () => { ran += 1; return 'done'; });

      expect(ran).toBe(1);
      expect(rows()).toEqual([]);
    });

    it.each(['ADMIN', 'SUPER_ADMIN', 'SUPPORT', 'DISPATCHER', 'ACCOUNTANT'])('a %s is logged', async (role) => {
      const { interceptor, admin, rows } = setup();

      await call(interceptor, patchUser(admin, { user: { id: admin.id, role } }), () => 'done');

      expect(rows()).toHaveLength(1);
      expect(rows()[0].actorRole).toBe(role);
    });

    it.each(['GET', 'HEAD', 'OPTIONS'])('a %s changes nothing and is not logged', async (method) => {
      const { interceptor, admin, rows } = setup();

      await call(interceptor, patchUser(admin, { method }), () => 'done');

      expect(rows()).toEqual([]);
    });

    it('a call without a person (a public route) is not logged', async () => {
      const { interceptor, admin, rows } = setup();

      await call(interceptor, patchUser(admin, { user: undefined }), () => 'done');
      await call(interceptor, patchUser(admin, { user: { role: 'ADMIN' } }), () => 'done');

      expect(rows()).toEqual([]);
    });

    it('anything that is not HTTP (a websocket) is not logged', async () => {
      const { interceptor, admin, rows } = setup();
      const stream = await interceptor.intercept(contextOf(patchUser(admin), undefined, 'ws'), handling(() => 'done'));

      expect(await lastValueFrom(stream)).toBe('done');
      expect(rows()).toEqual([]);
    });

    it('a route left out on purpose is not logged, whoever calls it', async () => {
      const { interceptor, admin, rows } = setup();

      expect(Object.keys(NOT_AUDITED_ROUTES)).toContain('PATCH /notifications/read-all');
      await call(interceptor, { method: 'PATCH', route: { path: '/api/notifications/read-all' }, params: {}, body: {}, user: { id: admin.id, role: 'ADMIN' } }, () => 'done');

      expect(rows()).toEqual([]);
    });

    it('a write route nobody listed is still logged, as unlisted, so nothing escapes', async () => {
      const { interceptor, admin, rows } = setup();

      expect(AUDITED_ROUTES['POST /brand-new/thing/:']).toBeUndefined();
      await call(interceptor, { method: 'POST', route: { path: '/api/brand-new/thing/:id' }, params: { id: '3' }, body: { a: 1 }, user: { id: admin.id, role: 'ADMIN' } }, () => ({ id: 3 }));

      expect(rows()[0]).toMatchObject({ action: 'unlisted', routeKey: 'POST /brand-new/thing/:', outcome: 'SUCCEEDED', targetType: null, targetId: null });
      expect(rows()[0].changedFields).toEqual(['a']);
    });

    it('a request without a matched route is logged as unlisted with an unknown route', async () => {
      const { interceptor, admin, rows } = setup();

      await call(interceptor, { method: 'DELETE', params: {}, user: { id: admin.id, role: 'ADMIN' } }, () => 'done');

      expect(rows()[0]).toMatchObject({ action: 'unlisted', routeKey: 'DELETE <unknown>' });
    });
  });

  describe('when the log itself breaks', () => {
    it('does not run the action when the row cannot be written: 503', async () => {
      await quietly(async (told) => {
        const { interceptor, admin, rows, m } = setup();
        let ran = 0;

        m.failNext('auditLog', 'create', new Error('database is down'));

        await expect(call(interceptor, patchUser(admin), () => { ran += 1; return 'done'; })).rejects.toBeInstanceOf(ServiceUnavailableException);

        expect(ran).toBe(0);
        expect(rows()).toEqual([]);
        expect(told).toHaveLength(1);
      });
    });

    it('leaves the answer alone when the row cannot be closed: the action has happened, the row stays STARTED', async () => {
      await quietly(async (told) => {
        const { interceptor, admin, rows, m } = setup();

        m.failNext('auditLog', 'updateMany', new Error('lost connection'));

        expect(await call(interceptor, patchUser(admin), () => ({ id: 42, done: true }))).toEqual({ id: 42, done: true });

        expect(rows()).toHaveLength(1);
        expect(rows()[0]).toMatchObject({ outcome: 'STARTED' });
        expect(rows()[0].finishedAt ?? null).toBeNull();
        expect(told).toHaveLength(1);
      });
    });

    it('passes the original error on when the row of a failed action cannot be closed either', async () => {
      await quietly(async (told) => {
        const { interceptor, admin, rows, m } = setup();

        m.failNext('auditLog', 'updateMany', new Error('lost connection'));

        await expect(call(interceptor, patchUser(admin), () => { throw new NotFoundException(); })).rejects.toBeInstanceOf(NotFoundException);
        expect(rows()[0].outcome).toBe('STARTED');
        expect(told).toHaveLength(1);
      });
    });

    it('does not run the action when writing the first row hangs: 503 after the time it is given', async () => {
      await quietly(async (told) => {
        const { world, interceptor, admin, rows } = setup();
        let ran = 0;

        world.prisma.auditLog.create = () => new Promise(() => {});
        interceptor.timeouts.begin = 20;

        await expect(call(interceptor, patchUser(admin), () => { ran += 1; return 'done'; })).rejects.toBeInstanceOf(ServiceUnavailableException);

        expect(ran).toBe(0);
        expect(rows()).toEqual([]);
        expect(told).toHaveLength(1);
      });
    });

    it('leaves the answer alone when closing the row hangs: it is given the time and then let go', async () => {
      await quietly(async (told) => {
        const { world, interceptor, admin, rows } = setup();

        world.prisma.auditLog.updateMany = () => new Promise(() => {});
        interceptor.timeouts.finish = 20;

        expect(await call(interceptor, patchUser(admin), () => ({ id: 42, done: true }))).toEqual({ id: 42, done: true });

        expect(rows()[0].outcome).toBe('STARTED');
        expect(told).toHaveLength(1);
      });
    });

    it('does not wait for the database longer than it was given, and not less: a slow write that ends in time is kept', async () => {
      const { world, interceptor, admin, rows } = setup();
      const real = world.prisma.auditLog.updateMany.bind(world.prisma.auditLog);

      world.prisma.auditLog.updateMany = (args: unknown) => new Promise((resolve) => setTimeout(() => resolve(real(args)), 30));
      interceptor.timeouts.finish = 2000;

      await call(interceptor, patchUser(admin), () => 'done');

      expect(rows()[0].outcome).toBe('SUCCEEDED');
    });

    it('still closes the row when what the request carried cannot be read: the action has happened', async () => {
      await quietly(async (told) => {
        const { interceptor, admin, rows } = setup();
        const body: Record<string, unknown> = { role: 'SUPPORT' };

        Object.defineProperty(body, 'broken', { enumerable: true, get() { throw new Error('getter exploded'); } });

        expect(await call(interceptor, patchUser(admin, { body }), () => 'done')).toBe('done');

        expect(rows()[0]).toMatchObject({ outcome: 'SUCCEEDED', statusCode: 200, targetId: '42' });
        expect(rows()[0].changedFields).toEqual([]);
        expect(told).toHaveLength(1);
      });
    });
  });

  describe('a handler that does not answer once', () => {
    const run = async (interceptor: AuditInterceptor, request: Record<string, unknown>, source: () => any) => {
      const stream = await interceptor.intercept(contextOf(request), { handle: source } as CallHandler);
      const seen: unknown[] = [];

      try {
        await new Promise<void>((resolve, reject) => stream.subscribe({ next: (value) => seen.push(value), error: reject, complete: resolve }));
      } catch (error) {
        seen.push(`error: ${(error as Error).message}`);
      }

      return seen;
    };

    it('a handler that completes without a value is a success', async () => {
      const { interceptor, admin, rows } = setup();

      await run(interceptor, patchUser(admin), () => EMPTY);

      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({ outcome: 'SUCCEEDED', statusCode: 200 });
    });

    it('closes the row on the first value only, and passes every value on', async () => {
      const { world, interceptor, admin, rows } = setup();
      const real = world.prisma.auditLog.updateMany.bind(world.prisma.auditLog);
      let closings = 0;

      world.prisma.auditLog.updateMany = (args: unknown) => { closings += 1; return real(args); };

      expect(await run(interceptor, patchUser(admin), () => of('a', 'b', 'c'))).toEqual(['a', 'b', 'c']);

      expect(closings).toBe(1);
      expect(rows()[0].outcome).toBe('SUCCEEDED');
    });

    it('an error after a value does not turn the row into a failure: it was a success when it answered (and the error still reaches the caller)', async () => {
      const { interceptor, admin, rows } = setup();

      expect(await run(interceptor, patchUser(admin), () => concat(of('a'), throwError(() => new Error('late'))))).toContain('error: late');

      expect(rows()[0].outcome).toBe('SUCCEEDED');
    });
  });

  describe('a closed row is not rewritten', () => {
    it('finishes a row once', async () => {
      const { world, interceptor, admin, rows } = setup();
      const service = new AuditService(world.prisma);

      await call(interceptor, patchUser(admin), () => 'done');
      const before = { ...rows()[0] };

      const second = await service.finish(rows()[0].id, { outcome: 'FAILED' as any, statusCode: 500, changedFields: ['tampered'], details: { x: 1 }, targetId: '1' });

      expect(second).toBe(false);
      expect(rows()[0]).toEqual(before);
    });

    it('does not finish a row that does not exist', async () => {
      const { world } = setup();

      expect(await new AuditService(world.prisma).finish(999, { outcome: 'SUCCEEDED' as any, statusCode: 200, changedFields: [], details: null })).toBe(false);
    });
  });
});
