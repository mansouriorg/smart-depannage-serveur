import { readDeliveryConfig } from '../../../config/delivery';
import { DeliveryError } from './delivery-error';
import { DeliveryProviders } from './delivery-providers';
import { backoffMs, OutboxService } from './outbox.service';

type Row = any;

/** An in-memory stand-in for the Prisma calls the outbox makes. updatedAt changes on every write, like @updatedAt. */
function makeWorld(options: {
  email?: Partial<{ configured: boolean; send: (m: any) => Promise<any> }>;
  sms?: Partial<{ configured: boolean; send: (to: string, text: string) => Promise<any> }>;
  push?: Partial<{ configured: boolean; send: (tokens: string[], m: any) => Promise<any> }>;
  env?: Record<string, string>;
  tokens?: Array<{ token: string; userId: number; isActive: boolean }>;
} = {}) {
  const rows: Row[] = [];
  const logs: Row[] = [1, 2, 3].map((id) => ({ id, status: 'PENDING' }));
  /** Lets a test make the writing of a result fail, as a lost database connection would. */
  const control = { failFinish: 0, tableMissing: false, failTokenUpdate: false };
  const tokens = options.tokens ?? [];
  let nextId = 1;
  let clock = 1;
  const tick = () => new Date(1_700_000_000_000 + clock++);

  const matches = (row: Row, where: any): boolean => {
    if (!where) return true;
    if (where.OR && !where.OR.some((w: any) => matches(row, w))) return false;
    if (where.channel !== undefined && row.channel !== where.channel) return false;
    if (where.id !== undefined) {
      if (where.id.in) {
        if (!where.id.in.includes(row.id)) return false;
      } else if (where.id.gt !== undefined) {
        if (!(row.id > where.id.gt)) return false;
      } else if (where.id.lt !== undefined) {
        if (!(row.id < where.id.lt)) return false;
      } else if (where.id.not !== undefined) {
        if (row.id === where.id.not) return false;
      } else if (row.id !== where.id) {
        return false;
      }
    }
    if (where.supersedeKey !== undefined && row.supersedeKey !== where.supersedeKey) return false;
    if (where.status !== undefined) {
      if (where.status.in ? !where.status.in.includes(row.status) : row.status !== where.status) return false;
    }
    if (where.updatedAt !== undefined && row.updatedAt.getTime() !== where.updatedAt.getTime()) return false;
    if (where.nextAttemptAt?.lte && !(row.nextAttemptAt <= where.nextAttemptAt.lte)) return false;
    if (where.lockedAt?.lt && !(row.lockedAt && row.lockedAt < where.lockedAt.lt)) return false;
    if (where.createdAt?.lt && !(row.createdAt < where.createdAt.lt)) return false;
    return true;
  };

  const prisma: any = {
    notificationOutbox: {
      create: async ({ data }: any) => {
        const row = {
          id: nextId++, status: 'PENDING', attempts: 0, nextAttemptAt: tick(), lockedAt: null, sentAt: null,
          provider: null, providerMessageId: null, lastError: null, createdAt: new Date(), updatedAt: tick(), ...data,
        };
        rows.push(row);
        return { id: row.id };
      },
      findMany: async ({ where, take }: any) => rows.filter((r) => matches(r, where)).slice(0, take ?? 1000).map((r) => ({ ...r })),
      findUnique: async ({ where }: any) => {
        const row = rows.find((r) => r.id === where.id);
        return row ? { ...row } : null;
      },
      updateMany: async ({ where, data }: any) => {
        const hit = rows.filter((r) => matches(r, where));
        hit.forEach((r) => Object.assign(r, data, { updatedAt: tick() }));
        return { count: hit.length };
      },
      findFirst: async ({ where }: any = {}) => {
        if (control.tableMissing) {
          throw Object.assign(new Error('The table `public.NotificationOutbox` does not exist'), { name: 'PrismaClientKnownRequestError', code: 'P2021' });
        }
        const row = rows.find((r) => matches(r, where));
        return row ? { ...row } : null;
      },
      update: async ({ where, data }: any) => {
        if (control.failFinish > 0 && ['SENT', 'FAILED', 'SKIPPED'].includes(data.status)) {
          control.failFinish--;
          throw new Error('connection lost');
        }
        const row = rows.find((r) => r.id === where.id)!;
        Object.assign(row, data, { updatedAt: tick() });
        return row;
      },
      deleteMany: async ({ where }: any) => {
        const hit = rows.filter((r) => matches(r, where));
        hit.forEach((r) => rows.splice(rows.indexOf(r), 1));
        return { count: hit.length };
      },
    },
    notificationDeliveryLog: {
      update: async ({ where, data }: any) => {
        const log = logs.find((l) => l.id === where.id)!;
        Object.assign(log, data);
        return log;
      },
      updateMany: async ({ where, data }: any) => {
        const hit = logs.filter((l) => where.id.in.includes(l.id));
        hit.forEach((l) => Object.assign(l, data));
        return { count: hit.length };
      },
    },
    pushDeviceToken: {
      findMany: async ({ where }: any) => tokens.filter((t) => t.userId === where.userId && t.isActive === where.isActive),
      updateMany: async ({ where, data }: any) => {
        if (control.failTokenUpdate) throw new Error('connection lost');
        const hit = tokens.filter((t) => where.token.in.includes(t.token));
        hit.forEach((t) => Object.assign(t, data));
        return { count: hit.length };
      },
    },
  };

  const sends: any[] = [];
  const provider = (kind: 'email' | 'sms' | 'push', cfg: any) => ({
    name: kind.toUpperCase(),
    isConfigured: () => cfg?.configured ?? true,
    send:
      cfg?.send ??
      (async (...args: any[]) => {
        sends.push({ kind, args });
        return { providerMessageId: `${kind}-1` };
      }),
  });

  const providers = new DeliveryProviders(
    provider('sms', options.sms) as any,
    provider('email', options.email) as any,
    provider('push', options.push) as any,
  );

  const config = readDeliveryConfig({ OUTBOX_WORKER: 'off', ...(options.env ?? {}) });
  const service = new OutboxService(prisma, providers, config);

  const lines: string[] = [];
  (service as any).logger = {
    log: (m: string) => lines.push(m),
    warn: (m: string) => lines.push(m),
    error: (m: string) => lines.push(m),
  };

  (service as any).recordRetryMs = 0;

  return { service, rows, logs, tokens, sends, lines, control };
}

const email = (extra: any = {}) => ({
  channel: 'EMAIL' as const,
  recipient: 'client@example.tn',
  subject: 'Vérification',
  body: 'Lien secret: https://x.tn/verify?token=AAA',
  ...extra,
});

describe('sending', () => {
  it('sends an e-mail, records it, erases the text, and updates the delivery log', async () => {
    const { service, rows, logs, sends } = makeWorld();
    await service.enqueue(email({ deliveryLogId: 1, userId: 10 }));

    expect(rows[0].status).toBe('PENDING');
    expect(rows[0].body).toContain('token=AAA');

    expect(await service.processDue()).toBe(1);

    expect(sends.length).toBe(1);
    expect(sends[0].args[0]).toEqual({ to: 'client@example.tn', subject: 'Vérification', text: 'Lien secret: https://x.tn/verify?token=AAA' });
    expect(rows[0].status).toBe('SENT');
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].providerMessageId).toBe('email-1');
    expect(rows[0].body).toBe('');
    expect(rows[0].subject).toBe(null);
    expect(logs[0].status).toBe('SENT');
    expect(logs[0].provider).toBe('EMAIL');
    expect(logs[0].providerMessageId).toBe('email-1');
  });

  it('a finished message is not sent again', async () => {
    const { service, sends } = makeWorld();
    await service.enqueue(email());

    await service.processDue();
    await service.processDue();

    expect(sends.length).toBe(1);
  });

  it('an SMS goes out as an E.164 number', async () => {
    const { service, sends, rows } = makeWorld();
    await service.enqueue({ channel: 'SMS', recipient: '22 123 456', body: 'Code 123456' });

    await service.processDue();

    expect(sends[0].args).toEqual(['+21622123456', 'Code 123456']);
    expect(rows[0].status).toBe('SENT');
    expect(rows[0].body).toBe('');
  });

  it('an invalid phone number fails at once and for good', async () => {
    const { service, rows, sends } = makeWorld();
    await service.enqueue({ channel: 'SMS', recipient: 'abc', body: 'Code 123456' });

    await service.processDue();

    expect(sends.length).toBe(0);
    expect(rows[0].status).toBe('FAILED');
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].body).toBe('');
  });
});

describe('retries', () => {
  const flaky = (failures: number, retryable = true) => {
    let calls = 0;
    return {
      calls: () => calls,
      send: async () => {
        calls++;
        if (calls <= failures) throw new DeliveryError('network error (ETIMEDOUT)', retryable);
        return { providerMessageId: 'ok' };
      },
    };
  };

  it('a temporary failure waits, with a growing delay, and the text is kept for the next try', async () => {
    const provider = flaky(2);
    const { service, rows } = makeWorld({ email: { send: provider.send } });
    await service.enqueue(email());
    const t0 = new Date();

    await service.processDue(t0);
    expect(rows[0].status).toBe('PENDING');
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].lastError).toBe('network error (ETIMEDOUT)');
    expect(rows[0].body).toContain('token=AAA');
    expect(rows[0].nextAttemptAt.getTime()).toBe(t0.getTime() + backoffMs(1));

    // not due yet: nothing happens
    expect(await service.processDue(new Date(t0.getTime() + 1000))).toBe(0);
    expect(provider.calls()).toBe(1);

    // time passes: second failure, longer wait
    const t1 = new Date(t0.getTime() + backoffMs(1) + 1000);
    await service.processDue(t1);
    expect(rows[0].attempts).toBe(2);
    expect(rows[0].nextAttemptAt.getTime()).toBe(t1.getTime() + backoffMs(2));

    // third try works
    await service.processDue(new Date(t1.getTime() + backoffMs(2) + 1000));
    expect(rows[0].status).toBe('SENT');
    expect(rows[0].attempts).toBe(3);
    expect(rows[0].body).toBe('');
  });

  it('gives up after the maximum number of attempts, and erases the text', async () => {
    const provider = flaky(99);
    const { service, rows, logs } = makeWorld({ email: { send: provider.send }, env: { OUTBOX_MAX_ATTEMPTS: '3' } });
    await service.enqueue(email({ deliveryLogId: 1 }));

    for (let i = 0; i < 5; i++) {
      await service.processDue(new Date(Date.now() + (i + 1) * 100 * 3_600_000));
    }

    expect(provider.calls()).toBe(3);
    expect(rows[0].status).toBe('FAILED');
    expect(rows[0].attempts).toBe(3);
    expect(rows[0].body).toBe('');
    expect(logs[0].status).toBe('FAILED');
    expect(logs[0].error).toBe('network error (ETIMEDOUT)');
  });

  it('a final failure is not retried', async () => {
    const provider = flaky(99, false);
    const { service, rows } = makeWorld({ email: { send: provider.send } });
    await service.enqueue(email());

    await service.processDue();
    await service.processDue(new Date(Date.now() + 100 * 3_600_000));

    expect(provider.calls()).toBe(1);
    expect(rows[0].status).toBe('FAILED');
  });

  it('an unexpected error is retried but its text is not kept', async () => {
    const { service, rows } = makeWorld({
      email: {
        send: async () => {
          throw new TypeError('Cannot read client@example.tn of undefined');
        },
      },
    });
    await service.enqueue(email());

    await service.processDue();

    expect(rows[0].status).toBe('PENDING');
    expect(rows[0].lastError).toBe('unexpected error (TypeError)');
  });

  it('the delays grow and stop growing', () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(120_000);
    expect(backoffMs(5)).toBe(21_600_000);
    expect(backoffMs(50)).toBe(21_600_000);
  });
});

describe('several workers', () => {
  it('two workers starting together send a message once', async () => {
    const { service, sends } = makeWorld();
    await service.enqueue(email());

    const [a, b] = await Promise.all([service.processDue(), service.processDue()]);

    expect(a + b).toBe(1);
    expect(sends.length).toBe(1);
  });

  it('a message stuck in SENDING after a crash is picked up again, a fresh one is not', async () => {
    const { service, rows, sends } = makeWorld();
    await service.enqueue(email());

    rows[0].status = 'SENDING';
    rows[0].lockedAt = new Date();
    expect(await service.processDue()).toBe(0);

    rows[0].lockedAt = new Date(Date.now() - 10 * 60_000);
    expect(await service.processDue()).toBe(1);
    expect(sends.length).toBe(1);
    expect(rows[0].status).toBe('SENT');
  });

  it('the first attempt right after enqueue goes through the same claim', async () => {
    const { service, rows, sends } = makeWorld();
    const { id } = await service.enqueue(email());

    expect(await service.processById(id)).toBe(true);
    expect(await service.processById(id)).toBe(false);
    expect(await service.processById(999)).toBe(false);
    expect(sends.length).toBe(1);
    expect(rows[0].status).toBe('SENT');
  });
});

describe('a channel without a provider', () => {
  it('fails at once, says why, and keeps the text out of the log', async () => {
    const { service, rows, lines } = makeWorld({ sms: { configured: false } });
    await service.enqueue({ channel: 'SMS', recipient: '22123456', body: 'Votre code de vérification est: 482913' });

    await service.processDue();

    expect(rows[0].status).toBe('FAILED');
    expect(rows[0].lastError).toBe('SMS provider not configured (SMS_PROVIDER)');
    expect(rows[0].body).toBe('');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain('482913');
      expect(line).not.toContain('22123456');
    }
  });

  it('DELIVERY_DEBUG_LOG shows the text of a message that cannot be sent, outside production only', async () => {
    const dev = makeWorld({ email: { configured: false }, env: { DELIVERY_DEBUG_LOG: 'true' } });
    await dev.service.enqueue(email());
    await dev.service.processDue();
    expect(dev.lines.some((l) => l.includes('token=AAA'))).toBe(true);

    const prod = makeWorld({ email: { configured: false }, env: { DELIVERY_DEBUG_LOG: 'true', NODE_ENV: 'production' } });
    await prod.service.enqueue(email());
    await prod.service.processDue();
    expect(prod.lines.some((l) => l.includes('token=AAA'))).toBe(false);

    const quiet = makeWorld({ email: { configured: false } });
    await quiet.service.enqueue(email());
    await quiet.service.processDue();
    expect(quiet.lines.some((l) => l.includes('token=AAA'))).toBe(false);
  });

  it('start-up says which channels are not configured, once each', async () => {
    const { service, lines } = makeWorld({ email: { configured: false }, sms: { configured: false } });

    service.onModuleInit();
    service.onModuleInit();
    await service.onModuleDestroy();

    expect(lines.filter((l) => l.includes('E-mail is not configured')).length).toBe(1);
    expect(lines.filter((l) => l.includes('SMS is not configured')).length).toBe(1);
    expect(lines.some((l) => l.includes('e-mail: NOT CONFIGURED'))).toBe(true);
  });

  it('tells the rest of the server what is configured', () => {
    const none = makeWorld({ email: { configured: false }, sms: { configured: false } }).service;
    expect(none.isEmailConfigured()).toBe(false);
    expect(none.isSmsConfigured()).toBe(false);
    expect(none.providerName('EMAIL')).toBe('EMAIL');

    const all = makeWorld().service;
    expect(all.isEmailConfigured()).toBe(true);
    expect(all.isSmsConfigured()).toBe(true);
  });
});

describe('push', () => {
  const device = (token: string, isActive = true) => ({ token, userId: 10, isActive });

  it('sends to the active devices of the user and notes the ticket', async () => {
    const { service, rows, sends } = makeWorld({
      tokens: [device('ExponentPushToken[a]'), device('ExponentPushToken[old]', false)],
      push: {
        send: async (tokens: string[]) => (
          (sendsRef.push(tokens)), tokens.map((token) => ({ token, ok: true, ticketId: 'ticket-1' }))
        ),
      },
    });
    const sendsRef: any[] = [];
    void sends;

    await service.enqueue({ channel: 'PUSH', userId: 10, subject: 'Titre', body: 'Corps', data: { interventionId: 3 } });
    await service.processDue();

    expect(sendsRef).toEqual([['ExponentPushToken[a]']]);
    expect(rows[0].status).toBe('SENT');
    expect(rows[0].providerMessageId).toBe('ticket-1');
  });

  it('no device: nothing to do, not an error', async () => {
    const { service, rows } = makeWorld();
    await service.enqueue({ channel: 'PUSH', userId: 10, subject: 'T', body: 'B' });

    await service.processDue();

    expect(rows[0].status).toBe('SKIPPED');
    expect(rows[0].lastError).toBe('no active device');
  });

  it('a device that unregistered is switched off', async () => {
    const { service, rows, tokens } = makeWorld({
      tokens: [device('ExponentPushToken[a]'), device('ExponentPushToken[b]')],
      push: {
        send: async () => [
          { token: 'ExponentPushToken[a]', ok: true, ticketId: 't' },
          { token: 'ExponentPushToken[b]', ok: false, gone: true, error: 'DeviceNotRegistered' },
        ],
      },
    });
    await service.enqueue({ channel: 'PUSH', userId: 10, subject: 'T', body: 'B' });

    await service.processDue();

    expect(rows[0].status).toBe('SENT');
    expect(tokens.find((t) => t.token === 'ExponentPushToken[b]')!.isActive).toBe(false);
    expect(tokens.find((t) => t.token === 'ExponentPushToken[a]')!.isActive).toBe(true);
  });

  it('every device gone: skipped; a rate limit: retried', async () => {
    const gone = makeWorld({
      tokens: [device('ExponentPushToken[a]')],
      push: { send: async () => [{ token: 'ExponentPushToken[a]', ok: false, gone: true, error: 'DeviceNotRegistered' }] },
    });
    await gone.service.enqueue({ channel: 'PUSH', userId: 10, subject: 'T', body: 'B' });
    await gone.service.processDue();
    expect(gone.rows[0].status).toBe('SKIPPED');

    const limited = makeWorld({
      tokens: [device('ExponentPushToken[a]')],
      push: { send: async () => [{ token: 'ExponentPushToken[a]', ok: false, retryable: true, error: 'MessageRateExceeded' }] },
    });
    await limited.service.enqueue({ channel: 'PUSH', userId: 10, subject: 'T', body: 'B' });
    await limited.service.processDue();
    expect(limited.rows[0].status).toBe('PENDING');
    expect(limited.rows[0].lastError).toBe('push not delivered (MessageRateExceeded)');
  });
});

describe('housekeeping', () => {
  it('deletes finished messages older than 30 days and nothing else', async () => {
    const { service, rows } = makeWorld();
    const old = new Date(Date.now() - 40 * 86_400_000);

    for (const status of ['SENT', 'FAILED', 'SKIPPED', 'PENDING', 'SENDING']) {
      await service.enqueue(email());
      rows[rows.length - 1].status = status;
      rows[rows.length - 1].createdAt = old;
    }
    await service.enqueue(email());
    rows[rows.length - 1].status = 'SENT'; // finished but recent

    expect(await service.purge()).toBe(3);
    expect(rows.map((r) => r.status).sort()).toEqual(['PENDING', 'SENDING', 'SENT']);
  });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A promise that a test resolves by hand, to hold a provider "in the middle of sending". */
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));

  return { promise, open };
}

describe('messages that stop being useful', () => {
  it('a message past its expiry is not sent, and its text is erased', async () => {
    const { service, rows, logs, sends } = makeWorld();
    await service.enqueue(email({ deliveryLogId: 1, expiresAt: new Date(Date.now() - 1000) }));

    await service.processDue();

    expect(sends.length).toBe(0);
    expect(rows[0].status).toBe('SKIPPED');
    expect(rows[0].attempts).toBe(0);
    expect(rows[0].lastError).toBe('expired before it could be sent');
    expect(rows[0].body).toBe('');
    expect(logs[0].status).toBe('SKIPPED');
  });

  it('a message that is still valid is sent, one that expires while waiting for a retry is not', async () => {
    let calls = 0;
    const { service, rows } = makeWorld({
      email: {
        send: async () => {
          calls++;
          throw new DeliveryError('network error (ETIMEDOUT)', true);
        },
      },
    });
    const t0 = new Date();
    await service.enqueue(email({ expiresAt: new Date(t0.getTime() + 10 * 60_000) }));

    await service.processDue(t0); // fails once, waits 30 s
    expect(rows[0].status).toBe('PENDING');

    await service.processDue(new Date(t0.getTime() + 60_000)); // still valid: tried again
    expect(calls).toBe(2);

    await service.processDue(new Date(t0.getTime() + 30 * 60_000)); // expired meanwhile
    expect(calls).toBe(2);
    expect(rows[0].status).toBe('SKIPPED');
    expect(rows[0].body).toBe('');
  });

  it('a newer message with the same key replaces the ones still waiting', async () => {
    let fail = true;
    const { service, rows, logs, sends } = makeWorld({
      sms: {
        send: async (to: string, text: string) => {
          if (fail) throw new DeliveryError('gateway down', true);
          sends2.push(text);
          return {};
        },
      },
    });
    const sends2: string[] = [];
    void sends;

    const sms = (body: string, extra: any = {}) => ({ channel: 'SMS' as const, recipient: '22123456', body, supersedeKey: 'phone-code:10', ...extra });

    await service.enqueue(sms('Code 111111', { deliveryLogId: 1 }));
    await service.processDue(); // gateway down: waiting for a retry
    await service.enqueue(sms('Code 222222', { deliveryLogId: 2 }));
    await service.enqueue({ channel: 'SMS', recipient: '22123456', body: 'Autre message', supersedeKey: 'phone-code:11', deliveryLogId: 3 });

    expect(rows[0].status).toBe('SKIPPED');
    expect(rows[0].lastError).toBe('replaced by a newer message');
    expect(rows[0].body).toBe('');
    expect(logs[0].status).toBe('SKIPPED');
    expect(rows[1].status).toBe('PENDING');
    expect(rows[2].status).toBe('PENDING'); // another key: untouched

    fail = false;
    await service.processDue(new Date(Date.now() + 3_600_000));

    expect(sends2.sort()).toEqual(['Autre message', 'Code 222222']);
  });

  it('two messages enqueued at the same moment never cancel each other: the later one wins', async () => {
    const { service, rows, sends } = makeWorld();
    const sms = (body: string) => ({ channel: 'SMS' as const, recipient: '22123456', body, supersedeKey: 'phone-code:10' });

    await Promise.all([service.enqueue(sms('Code 111111')), service.enqueue(sms('Code 222222'))]);

    expect(rows.filter((r) => r.status === 'PENDING').map((r) => r.body)).toEqual(['Code 222222']);
    expect(rows.filter((r) => r.status === 'SKIPPED').length).toBe(1);

    await service.processDue();
    expect(sends.length).toBe(1);
  });

  it('a message that already left is never touched by a later one', async () => {
    const { service, rows } = makeWorld();
    const sms = (body: string) => ({ channel: 'SMS' as const, recipient: '22123456', body, supersedeKey: 'phone-code:10' });

    await service.enqueue(sms('Code 111111'));
    await service.processDue();
    await service.enqueue(sms('Code 222222'));

    expect(rows[0].status).toBe('SENT');
    expect(rows[1].status).toBe('PENDING');
  });
});

describe('the bookkeeping', () => {
  it('a message that was sent is never sent again because writing the result failed', async () => {
    const { service, rows, sends, control, lines } = makeWorld();
    await service.enqueue(email({ deliveryLogId: 1 }));
    control.failFinish = 3; // all three tries to write the result fail

    await service.processDue();
    expect(sends.length).toBe(1);
    expect(rows[0].status).toBe('SENDING');
    expect(lines.some((l) => l.includes('could not be recorded'))).toBe(true);

    // even long after the lock would be considered stale
    await service.processDue(new Date(Date.now() + 3_600_000));
    expect(sends.length).toBe(1);

    // the next worker round writes the result down
    await (service as any).tick();
    expect(sends.length).toBe(1);
    expect(rows[0].status).toBe('SENT');
    expect(rows[0].body).toBe('');
  });

  it('a result that fails to be written once is written on a later try, without a second send', async () => {
    const { service, rows, sends, control } = makeWorld();
    await service.enqueue(email());
    control.failFinish = 1;

    await service.processDue();

    expect(sends.length).toBe(1);
    expect(rows[0].status).toBe('SENT');
  });

  it('no error text from the database reaches the log', async () => {
    const { service, control, lines } = makeWorld();
    await service.enqueue(email());
    control.failFinish = 3;

    await service.processDue();

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain('connection lost');
      expect(line).not.toContain('token=AAA');
    }
    expect(lines.some((l) => l.includes('Error'))).toBe(true);
  });

  it('each message is stamped with the time at which it is handled, not the start of the round', async () => {
    const slow = {
      send: async () => {
        await sleep(60);
        throw new DeliveryError('network error (ETIMEDOUT)', true);
      },
    };
    const { service, rows } = makeWorld({ email: slow });
    await service.enqueue(email());
    await service.enqueue(email());

    await service.processDue(); // no injected clock

    const gap = rows[1].nextAttemptAt.getTime() - rows[0].nextAttemptAt.getTime();
    expect(gap).toBeGreaterThan(40);
  });
});

describe('channels and shutdown', () => {
  it('a database error in one channel does not stop the others from finishing the round', async () => {
    const { service, rows } = makeWorld({
      sms: { send: async () => ({}) },
    });
    await service.enqueue({ channel: 'SMS', recipient: '22123456', body: 'Code 123456' });
    await service.enqueue(email());

    const original = (service as any).claim.bind(service);
    (service as any).claim = async (row: any, now: Date) => {
      if (row.channel === 'SMS') throw new Error('connection lost');
      await sleep(30);
      return original(row, now);
    };

    let error: any;
    try {
      await service.processDue();
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeDefined();
    // the e-mail group ran to the end before the round reported the SMS group's error
    expect(rows[1].status).toBe('SENT');
  });

  it('a slow SMS gateway does not hold back e-mail', async () => {
    const hold = gate();
    const { service, rows } = makeWorld({
      sms: { send: async () => (await hold.promise, {}) },
    });
    await service.enqueue({ channel: 'SMS', recipient: '22123456', body: 'Code 123456' });
    await service.enqueue(email());

    const round = service.processDue();
    await sleep(30);

    expect(rows[1].status).toBe('SENT'); // e-mail went out while the SMS is still in flight
    expect(rows[0].status).toBe('SENDING');

    hold.open();
    expect(await round).toBe(2);
    expect(rows[0].status).toBe('SENT');
  });

  it('at most five first attempts run at once, the rest wait for the worker', async () => {
    const hold = gate();
    let started = 0;
    const { service, rows } = makeWorld({
      env: { OUTBOX_WORKER: 'on' },
      email: { send: async () => (started++, await hold.promise, {}) },
    });

    for (let i = 0; i < 8; i++) {
      await service.enqueue(email());
    }
    await sleep(30);

    expect(started).toBe(5);
    expect(rows.filter((r) => r.status === 'PENDING').length).toBe(3);

    hold.open();
    await service.onModuleDestroy();
    expect(rows.filter((r) => r.status === 'SENT').length).toBe(5);

    // the worker finishes the rest
    expect(await service.processDue(new Date(Date.now() + 60_000))).toBe(0); // closing: takes no new work
  });

  it('shutdown waits for a message being sent and takes no new work', async () => {
    const hold = gate();
    const { service, rows } = makeWorld({
      env: { OUTBOX_WORKER: 'on' },
      email: { send: async () => (await hold.promise, { providerMessageId: 'x' }) },
    });
    await service.enqueue(email());
    await sleep(20); // the first attempt is in flight

    let closed = false;
    const closing = service.onModuleDestroy().then(() => (closed = true));
    await sleep(20);
    expect(closed).toBe(false);

    hold.open();
    await closing;
    expect(closed).toBe(true);
    expect(rows[0].status).toBe('SENT');

    await service.enqueue(email());
    await sleep(20);
    expect(rows[1].status).toBe('PENDING'); // no first attempt after shutdown began
  });
});

describe('start-up check', () => {
  it('says plainly when the outbox table does not exist, without echoing the database error', async () => {
    const { service, control, lines } = makeWorld();
    control.tableMissing = true;

    await (service as any).selfCheck();

    const line = lines.find((l) => l.includes('NotificationOutbox'))!;
    expect(line).toBeDefined();
    expect(line).toContain('prisma db push');
    expect(line).toContain('P2021');
    expect(line).not.toContain('does not exist');
  });

  it('is silent when the table is there', async () => {
    const { service, lines } = makeWorld();

    await (service as any).selfCheck();

    expect(lines.length).toBe(0);
  });
});

describe('a message that stopped being useful while it was being retried', () => {
  const failing = () => ({
    send: async () => {
      throw new DeliveryError('network error (ETIMEDOUT)', true);
    },
  });

  const sms = (body: string, extra: any = {}) => ({ channel: 'SMS' as const, recipient: '22123456', body, supersedeKey: 'phone-code:10', ...extra });

  it('a message replaced while it waited in SENDING (a crashed worker) is dropped, not sent', async () => {
    const attempted: string[] = [];
    const { service, rows, logs } = makeWorld({
      sms: {
        send: async (_to: string, text: string) => {
          attempted.push(text);
          return {};
        },
      },
    });

    await service.enqueue(sms('Code 111111', { deliveryLogId: 1 }));
    rows[0].status = 'SENDING';
    rows[0].lockedAt = new Date(Date.now() - 10 * 60_000);
    await service.enqueue(sms('Code 222222'));

    await service.processDue(new Date(), 'SMS');

    expect(attempted).toEqual(['Code 222222']);
    expect(rows[0].status).toBe('SKIPPED');
    expect(rows[0].lastError).toBe('replaced by a newer message');
    expect(rows[0].body).toBe('');
    expect(logs[0].status).toBe('SKIPPED');
  });

  it('a message replaced while it was being sent is not retried when it fails', async () => {
    let service: any;
    const attempted: string[] = [];
    const world = makeWorld({
      sms: {
        send: async (_to: string, text: string) => {
          attempted.push(text);
          if (text === 'Code 111111') {
            // the user asks again while the gateway is still answering "try later"
            await service.enqueue(sms('Code 222222'));
            throw new DeliveryError('gateway down', true);
          }
          return {};
        },
      },
    });
    service = world.service;

    await service.enqueue(sms('Code 111111', { deliveryLogId: 1 }));
    await service.processDue(new Date(), 'SMS'); // first message: fails, the newer one arrives meanwhile

    expect(world.rows[0].status).toBe('SKIPPED');
    expect(world.rows[0].lastError).toBe('replaced by a newer message');
    expect(world.rows[0].body).toBe('');

    await service.processDue(new Date(Date.now() + 3_600_000), 'SMS');
    expect(attempted).toEqual(['Code 111111', 'Code 222222']);
    expect(world.rows[1].status).toBe('SENT');
  });

  it('is dropped at once when the next try would come after it expires', async () => {
    const provider = failing();
    const { service, rows } = makeWorld({ email: provider });
    const t0 = new Date();
    // valid for 20 seconds: the first retry would be in 30
    await service.enqueue(email({ expiresAt: new Date(t0.getTime() + 20_000) }));

    await service.processDue(t0);

    expect(rows[0].status).toBe('SKIPPED');
    expect(rows[0].lastError).toBe('expired before it could be sent');
    expect(rows[0].body).toBe('');
    expect(rows[0].attempts).toBe(1);
  });

  it('a message with a long enough life is still retried', async () => {
    const { service, rows } = makeWorld({ email: failing() });
    const t0 = new Date();
    await service.enqueue(email({ expiresAt: new Date(t0.getTime() + 3_600_000) }));

    await service.processDue(t0);

    expect(rows[0].status).toBe('PENDING');
    expect(rows[0].body).toContain('token=AAA');
  });
});

describe('addresses that cannot receive mail', () => {
  it('a placeholder address is skipped, not handed to the mail server', async () => {
    const { service, rows, sends, logs } = makeWorld();
    await service.enqueue(email({ recipient: 'guest_0b6e1f6a@guest.smart-depannage.local', deliveryLogId: 1 }));

    await service.processDue();

    expect(sends.length).toBe(0);
    expect(rows[0].status).toBe('SKIPPED');
    expect(rows[0].lastError).toBe('this address cannot receive e-mail');
    expect(rows[0].body).toBe('');
    expect(logs[0].status).toBe('SKIPPED');
  });
});

describe('push bookkeeping', () => {
  it('a database error while switching a device off does not send the push a second time', async () => {
    const { service, rows, tokens, control } = makeWorld({
      tokens: [
        { token: 'ExponentPushToken[a]', userId: 10, isActive: true },
        { token: 'ExponentPushToken[b]', userId: 10, isActive: true },
      ],
      push: {
        send: async () => [
          { token: 'ExponentPushToken[a]', ok: true, ticketId: 't' },
          { token: 'ExponentPushToken[b]', ok: false, gone: true, error: 'DeviceNotRegistered' },
        ],
      },
    });
    control.failTokenUpdate = true;
    await service.enqueue({ channel: 'PUSH', userId: 10, subject: 'T', body: 'B' });

    await service.processDue();

    expect(rows[0].status).toBe('SENT');
    expect(rows[0].attempts).toBe(1);
    expect(tokens.every((t) => t.isActive)).toBe(true); // switching off will happen on a later push
  });
});

describe('the worker round', () => {
  it('a slow SMS gateway does not hold back the next round of e-mail', async () => {
    const hold = gate();
    const { service, rows } = makeWorld({ sms: { send: async () => (await hold.promise, {}) } });
    await service.enqueue({ channel: 'SMS', recipient: '22123456', body: 'Code 123456' });

    const firstRound = (service as any).tick();
    await sleep(20);

    // the SMS round is still running; e-mail that arrives now is sent by the next round
    await service.enqueue(email());
    await (service as any).tick();
    expect(rows[1].status).toBe('SENT');
    expect(rows[0].status).toBe('SENDING');

    hold.open();
    await firstRound;
    expect(rows[0].status).toBe('SENT');
  });

  it('a burst is cleared in one round, not twenty messages every 15 seconds', async () => {
    const { service, rows } = makeWorld();

    for (let i = 0; i < 65; i++) {
      await service.enqueue(email());
    }

    await (service as any).tick();

    expect(rows.filter((r) => r.status === 'SENT').length).toBe(65);
  });

  it('shutdown makes a last try to write down results that are still waiting', async () => {
    const { service, rows, sends, control } = makeWorld();
    await service.enqueue(email());
    control.failFinish = 3;
    await service.processDue();
    expect(rows[0].status).toBe('SENDING');

    await service.onModuleDestroy();

    expect(rows[0].status).toBe('SENT');
    expect(sends.length).toBe(1);
  });
});
