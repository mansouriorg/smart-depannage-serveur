import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import { transitionStatus, transitionStatusDetailed } from './transition-status';

type Row = { id: number; status: string; artisanId: number | null; [key: string]: unknown };

/** A tiny stand-in for the two Prisma calls the helper uses. */
function fakeDb(initial: Row | null, options: { changeBeforeUpdate?: string } = {}) {
  const row = initial;
  const updates: any[] = [];

  const db = {
    intervention: {
      findUnique: async () => (row ? { ...row } : null),
      update: async (args: any) => {
        updates.push(args);

        if (options.changeBeforeUpdate && row) {
          row.status = options.changeBeforeUpdate;
        }

        const where = args.where ?? {};
        const notFound = Object.assign(new Error('Record not found'), { code: 'P2025' });

        if (!row || (where.id !== undefined && where.id !== row.id)) throw notFound;
        if (where.status !== undefined && where.status !== row.status) throw notFound;

        for (const [key, value] of Object.entries(where)) {
          if (['id', 'status', 'OR'].includes(key)) continue;
          if ((row as any)[key] !== value) throw notFound;
        }

        if (Array.isArray(where.OR)) {
          const match = where.OR.some((cond: any) =>
            Object.entries(cond).every(([k, v]) => (row as any)[k] === v),
          );
          if (!match) throw notFound;
        }

        Object.assign(row, args.data);
        return { ...row };
      },
    },
  };

  return { db, updates, row };
}

async function failure(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('expected the call to fail');
}

const staff = { kind: 'staff', userId: 1 } as const;
const artisan = { kind: 'artisan', userId: 20 } as const;
const client = { kind: 'client', userId: 10 } as const;

describe('transitionStatus', () => {
  it('moves the status, stamps the change and compares with the old status', async () => {
    const { db, updates, row } = fakeDb({ id: 5, status: 'ASSIGNED', artisanId: 20 });

    const result = await transitionStatusDetailed(db, {
      id: 5,
      to: 'ARTISAN_ACCEPTED',
      actor: artisan,
      data: { artisanAcceptedAt: new Date(0) },
    });

    expect(result.changed).toBe(true);
    expect(result.previousStatus).toBe('ASSIGNED');
    expect(row!.status).toBe('ARTISAN_ACCEPTED');
    expect(updates.length).toBe(1);
    expect(updates[0].where.id).toBe(5);
    expect(updates[0].where.status).toBe('ASSIGNED');
    expect(updates[0].data.lastStatusChangedAt instanceof Date).toBe(true);
    expect((updates[0].data.artisanAcceptedAt as Date).getTime()).toBe(0);
  });

  it('refuses an invalid jump with 409 and writes nothing', async () => {
    const { db, updates } = fakeDb({ id: 5, status: 'CREATED', artisanId: null });

    const error = await failure(transitionStatus(db, { id: 5, to: 'PAID', actor: staff }));

    expect(error instanceof ConflictException).toBe(true);
    expect(String(error.message)).toContain('CREATED -> PAID');
    expect(updates.length).toBe(0);
  });

  it('refuses the right move by the wrong person with 403', async () => {
    const { db, updates } = fakeDb({ id: 5, status: 'COMPLETED', artisanId: 20 });

    const error = await failure(transitionStatus(db, { id: 5, to: 'PAID', actor: artisan }));

    expect(error instanceof ForbiddenException).toBe(true);
    expect(updates.length).toBe(0);
  });

  it('refuses an unknown status with 400', async () => {
    const { db } = fakeDb({ id: 5, status: 'CREATED', artisanId: null });

    const error = await failure(transitionStatus(db, { id: 5, to: 'FLYING', actor: staff }));

    expect(error instanceof BadRequestException).toBe(true);
  });

  it('404 when the job does not exist', async () => {
    const { db } = fakeDb(null);

    const error = await failure(transitionStatus(db, { id: 9, to: 'CANCELLED', actor: staff }));

    expect(error instanceof NotFoundException).toBe(true);
  });

  it('understands the old spellings on both sides', async () => {
    const { db, row } = fakeDb({ id: 5, status: 'PENDING', artisanId: null });

    await transitionStatus(db, { id: 5, to: 'ACCEPTED', actor: staff, data: { artisanId: 20 } });

    expect(row!.status).toBe('ACCEPTED');
    expect(row!.artisanId).toBe(20);
  });

  it('stores the canonical spelling once STATUS_STORAGE=canonical', async () => {
    const previous = process.env.STATUS_STORAGE;
    process.env.STATUS_STORAGE = 'canonical';

    try {
      const { db, row } = fakeDb({ id: 5, status: 'PENDING', artisanId: null });
      await transitionStatus(db, { id: 5, to: 'ACCEPTED', actor: staff, data: { artisanId: 20 } });
      expect(row!.status).toBe('ARTISAN_ACCEPTED');
    } finally {
      if (previous === undefined) delete process.env.STATUS_STORAGE;
      else process.env.STATUS_STORAGE = previous;
    }
  });

  it('does not let a job reach an artisan-only status without an artisan', async () => {
    const { db, updates } = fakeDb({ id: 5, status: 'CREATED', artisanId: null });

    const error = await failure(
      transitionStatus(db, { id: 5, to: 'ARTISAN_ACCEPTED', actor: staff }),
    );

    expect(error instanceof BadRequestException).toBe(true);
    expect(updates.length).toBe(0);
  });

  it('counts an artisan written in the same call', async () => {
    const { db, row } = fakeDb({ id: 5, status: 'WAITING_ADMIN_REVIEW', artisanId: null });

    await transitionStatus(db, { id: 5, to: 'ASSIGNED', actor: staff, data: { artisanId: 20 } });

    expect(row!.status).toBe('ASSIGNED');
  });

  it('allows changing other columns without a new status', async () => {
    const { db, updates } = fakeDb({ id: 5, status: 'ASSIGNED', artisanId: 20 });

    const result = await transitionStatusDetailed(db, {
      id: 5,
      to: 'ASSIGNED',
      actor: staff,
      data: { artisanId: 21 },
    });

    expect(result.changed).toBe(false);
    expect(updates.length).toBe(1);
    expect('status' in updates[0].data).toBe(false);
    expect('lastStatusChangedAt' in updates[0].data).toBe(false);
    expect(updates[0].data.artisanId).toBe(21);
  });

  it('writes dataOnChange only when the status really changes', async () => {
    const moving = fakeDb({ id: 5, status: 'ASSIGNED', artisanId: 20 });
    await transitionStatus(moving.db, {
      id: 5,
      to: 'ARTISAN_ACCEPTED',
      actor: artisan,
      dataOnChange: { artisanAcceptedAt: new Date(0) },
    });
    expect((moving.updates[0].data.artisanAcceptedAt as Date).getTime()).toBe(0);

    const staying = fakeDb({ id: 5, status: 'ARTISAN_ACCEPTED', artisanId: 20 });
    const result = await transitionStatusDetailed(staying.db, {
      id: 5,
      to: 'ACCEPTED',
      actor: artisan,
      dataOnChange: { artisanAcceptedAt: new Date(0) },
    });
    expect(result.changed).toBe(false);
    expect(staying.updates.length).toBe(0);
  });

  it('does nothing when the status is already there and no column changes', async () => {
    const { db, updates } = fakeDb({ id: 5, status: 'CANCELLED', artisanId: null });

    const result = await transitionStatusDetailed(db, { id: 5, to: 'CANCELLED', actor: client });

    expect(result.changed).toBe(false);
    expect(updates.length).toBe(0);
    expect(result.row.status).toBe('CANCELLED');
  });

  it('answers 409 when somebody else changed the job first', async () => {
    const { db } = fakeDb(
      { id: 5, status: 'WAITING_ADMIN_REVIEW', artisanId: null },
      { changeBeforeUpdate: 'ARTISAN_ACCEPTED' },
    );

    const error = await failure(
      transitionStatus(db, {
        id: 5,
        to: 'QUOTE_SENT',
        actor: staff,
        conflictMessage: 'Quelqu’un a été plus rapide.',
      }),
    );

    expect(error instanceof ConflictException).toBe(true);
    expect(String(error.message)).toContain('plus rapide');
  });

  it('adds the caller conditions to the same UPDATE (take an open job)', async () => {
    const claim = {
      id: 5,
      to: 'ACCEPTED',
      actor: artisan,
      data: { artisanId: 20 },
      where: { OR: [{ artisanId: null }, { artisanId: 20 }] },
    } as const;

    const free = fakeDb({ id: 5, status: 'PENDING', artisanId: null });
    await transitionStatus(free.db, claim);
    expect(free.row!.artisanId).toBe(20);

    const taken = fakeDb({ id: 5, status: 'PENDING', artisanId: 99 });
    const error = await failure(transitionStatus(taken.db, claim));
    expect(error instanceof ConflictException).toBe(true);
    expect(taken.row!.artisanId).toBe(99);
  });

  it('an artisan can only write to their own job, even if it changes hands meanwhile', async () => {
    const mine = fakeDb({ id: 5, status: 'ARTISAN_ACCEPTED', artisanId: 20 });
    await transitionStatus(mine.db, { id: 5, to: 'ARTISAN_ON_THE_WAY', actor: artisan });
    expect(mine.updates[0].where.artisanId).toBe(20);
    expect(mine.row!.status).toBe('ARTISAN_ON_THE_WAY');

    // staff gave the job to artisan 21 after the service checked the owner
    const handedOver = fakeDb({ id: 5, status: 'ARTISAN_ACCEPTED', artisanId: 21 });
    const error = await failure(
      transitionStatus(handedOver.db, { id: 5, to: 'ARTISAN_ON_THE_WAY', actor: artisan }),
    );
    expect(error instanceof ConflictException).toBe(true);
    expect(handedOver.row!.status).toBe('ARTISAN_ACCEPTED');

    // staff are not tied to an artisan
    const byStaff = fakeDb({ id: 5, status: 'ARTISAN_ACCEPTED', artisanId: 21 });
    await transitionStatus(byStaff.db, { id: 5, to: 'ARTISAN_ON_THE_WAY', actor: staff });
    expect('artisanId' in byStaff.updates[0].where).toBe(false);
  });

  it('allowedFrom narrows the table for one action', async () => {
    const { db, updates } = fakeDb({ id: 5, status: 'ARTISAN_ON_THE_WAY', artisanId: 20 });

    const error = await failure(
      transitionStatus(db, {
        id: 5,
        to: 'IN_PROGRESS',
        actor: artisan,
        allowedFrom: ['ARTISAN_ARRIVED'],
      }),
    );

    expect(error instanceof ConflictException).toBe(true);
    expect(updates.length).toBe(0);
  });

  it('soft mode skips what is not allowed instead of failing', async () => {
    const { db, updates, row } = fakeDb({ id: 5, status: 'IN_PROGRESS', artisanId: 20 });

    const result = await transitionStatusDetailed(db, {
      id: 5,
      to: 'PAYMENT_PENDING',
      actor: { kind: 'system' },
      soft: true,
    });

    expect(result.changed).toBe(false);
    expect(result.skipped).toBe('not_allowed');
    expect(result.row.status).toBe('IN_PROGRESS');
    expect(updates.length).toBe(0);
    expect(row!.status).toBe('IN_PROGRESS');
  });

  it('soft mode still applies an allowed move', async () => {
    const { db, row } = fakeDb({ id: 5, status: 'COMPLETED', artisanId: 20 });

    const result = await transitionStatusDetailed(db, {
      id: 5,
      to: 'PAID',
      actor: { kind: 'system' },
      soft: true,
    });

    expect(result.changed).toBe(true);
    expect(row!.status).toBe('PAID');
  });

  it('soft mode skips only the status: the other columns are still written', async () => {
    const { db, updates, row } = fakeDb({ id: 5, status: 'INVOICE_SENT', artisanId: 20 });

    const result = await transitionStatusDetailed(db, {
      id: 5,
      to: 'PAYMENT_PENDING',
      actor: { kind: 'client', userId: 10 },
      data: { paymentPendingAt: new Date(5) },
      dataOnChange: { quoteAcceptedAt: new Date(6) },
      soft: true,
    });

    expect(result.changed).toBe(false);
    expect(result.skipped).toBe('not_allowed');
    expect(updates.length).toBe(1);
    expect('status' in updates[0].data).toBe(false);
    expect('lastStatusChangedAt' in updates[0].data).toBe(false);
    expect('quoteAcceptedAt' in updates[0].data).toBe(false);
    expect((row!.paymentPendingAt as Date).getTime()).toBe(5);
    expect(row!.status).toBe('INVOICE_SENT');
    expect(result.row.status).toBe('INVOICE_SENT');
  });

  it('soft mode also survives a concurrent change', async () => {
    const { db } = fakeDb(
      { id: 5, status: 'COMPLETED', artisanId: 20 },
      { changeBeforeUpdate: 'DISPUTED' },
    );

    const result = await transitionStatusDetailed(db, {
      id: 5,
      to: 'PAID',
      actor: { kind: 'system' },
      soft: true,
    });

    expect(result.changed).toBe(false);
    expect(result.skipped).toBe('changed_meanwhile');
  });

  it('rejects a status passed through data', async () => {
    const { db } = fakeDb({ id: 5, status: 'CREATED', artisanId: null });

    const error = await failure(
      transitionStatus(db, { id: 5, to: 'CANCELLED', actor: staff, data: { status: 'PAID' } }),
    );

    expect(String(error.message)).toContain('`to`');
  });

  it('lets other errors through', async () => {
    const { db } = fakeDb({ id: 5, status: 'CREATED', artisanId: null });
    db.intervention.update = async () => {
      throw new Error('connection lost');
    };

    const error = await failure(transitionStatus(db, { id: 5, to: 'CANCELLED', actor: staff }));

    expect(String(error.message)).toBe('connection lost');
  });
});
