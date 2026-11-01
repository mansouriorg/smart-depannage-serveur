import { createHash } from 'crypto';

import { FakeTable, withTransactions } from '../../common/testing/fake-tables';
import { InterventionsController } from './interventions.controller';
import { InterventionsService } from './interventions.service';

/**
 * POST /interventions/secure: the dashboard's "create a ticket" and the older apps of a signed-in customer. (Until P3-03 the same
 * method also took a request from a visitor with no account and made a guest profile from the phone number; that route and its
 * tests are gone, `/guest/interventions` does it and `guest-activation.spec.ts` (the profile and the number) and `guest-request.spec.ts`
 * cover it.)
 */
function makeWorld() {
  const users = new FakeTable({
    unique: ['email', 'phoneKey'],
    defaults: () => ({ role: 'CLIENT', isActive: true, isGuest: false, deletedAt: null, phone: null, phoneKey: null }),
  });

  const created: any[] = [];
  const intervention = {
    create: async ({ data }: any) => {
      const { client, ...rest } = data;
      const owner = users.rows.find((u) => u.id === client.connect.id);
      const row = { id: created.length + 1, ...rest, clientId: client.connect.id, serviceType: rest.serviceType ?? 'PLOMBIER', client: owner };
      created.push(row);
      return row;
    },
  };

  const prisma: any = withTransactions({ user: users, intervention }, [users]);
  const gateway: any = { sendNewIntervention: () => undefined };
  const notifications: any = { sendSms: async () => ({ queued: true }) };
  const alerts: any[] = [];
  const staffAlerts: any = { newRequest: async (request: any) => alerts.push(request) };

  return { users, created, alerts, service: new InterventionsService(prisma, gateway, notifications, staffAlerts, {} as any) };
}

const form = (contactPhone: string, extra: Record<string, unknown> = {}) =>
  ({ contactPhone, contactName: 'Sami', serviceType: 'PLOMBIER', description: 'Fuite', address: 'Tunis', ...extra }) as any;

describe('a request made by a signed-in account: the back office is alerted (P1-04)', () => {
  it('the alert service is called once with the request that was created, after the row exists', async () => {
    const w = makeWorld();
    const owner = w.users.insert({ email: 'real@mail.tn', password: 'x', role: 'CLIENT' });

    await w.service.create(owner.id, form('55 111 222'));

    expect(w.created.length).toBe(1);
    expect(w.alerts.length).toBe(1);
    expect(w.alerts[0].id).toBe(w.created[0].id);
    expect(w.alerts[0].serviceType).toBe('PLOMBIER');
  });

  it('a signed-in client keeps the photos the app sent', async () => {
    const w = makeWorld();
    const owner = w.users.insert({ email: 'real@mail.tn', password: 'x', role: 'CLIENT' });

    await w.service.create(owner.id, form('55 111 222', { photos: ['/files/3/download'] }));

    expect(w.created[0].photos).toEqual(['/files/3/download']);
  });

  it('the request belongs to the account that made it: it is connected to that account, and no profile is made from the phone number', async () => {
    const w = makeWorld();
    const owner = w.users.insert({ email: 'real@mail.tn', password: 'x', role: 'CLIENT' });
    const before = w.users.rows.length;

    await w.service.create(owner.id, form('55 111 222'));

    expect(w.created[0].clientId).toBe(owner.id);
    expect(w.users.rows.length).toBe(before);
  });
});

describe('the contact fields of the form (a request made by an account is the account\'s own)', () => {
  it('the contact name and phone typed in the form are left out of the job: the account holds them (the dashboard sends them and they are dropped, as before P3-03)', async () => {
    const w = makeWorld();
    const owner = w.users.insert({ email: 'real@mail.tn', password: 'x', role: 'CLIENT' });

    await w.service.create(owner.id, form('55 111 222', { contactName: 'Sami' }), 'ADMIN');

    expect(w.created.length).toBe(1);
    expect('contactName' in w.created[0]).toBe(false);
    expect('contactPhone' in w.created[0]).toBe(false);
    expect(w.created[0].description).toBe('Fuite');
  });
});

describe('the tracking link of a request (P1-02)', () => {
  it('only the hash of the link is stored; the answer carries the link itself, once, and never the hash', async () => {
    const w = makeWorld();
    const owner = w.users.insert({ email: 'real@mail.tn', password: 'x', role: 'CLIENT' });
    const answer: any = await w.service.create(owner.id, form('55 111 222'));

    expect(typeof answer.rawTrackingToken).toBe('string');
    expect(answer.rawTrackingToken.length).toBeGreaterThanOrEqual(32);
    expect(w.created[0].trackingToken).toBe(createHash('sha256').update(answer.rawTrackingToken).digest('hex'));
    expect(w.created[0].trackingToken).not.toBe(answer.rawTrackingToken);
    expect(answer).not.toHaveProperty('trackingToken');
  });

  it('two requests do not share a link', async () => {
    const w = makeWorld();
    const owner = w.users.insert({ email: 'real@mail.tn', password: 'x', role: 'CLIENT' });
    const first: any = await w.service.create(owner.id, form('55 111 222'));
    const second: any = await w.service.create(owner.id, form('55 111 222'));

    expect(first.rawTrackingToken).not.toBe(second.rawTrackingToken);
    expect(w.created[0].trackingToken).not.toBe(w.created[1].trackingToken);
  });
});

describe('the bot check fields are not job columns (P1-16)', () => {
  it('the three fields are read by the guard and never written to the job', async () => {
    const w = makeWorld();
    const owner = w.users.insert({ email: 'real@mail.tn', password: 'x', role: 'CLIENT' });

    await w.service.create(owner.id, form('55 111 222', { botChallenge: 'v1.x', botSolution: 'abc', website: '' }));

    expect(w.created.length).toBe(1);
    expect('botChallenge' in w.created[0]).toBe(false);
    expect('botSolution' in w.created[0]).toBe(false);
    expect('website' in w.created[0]).toBe(false);
    expect(w.created[0].description).toBe('Fuite');
  });
});

describe('the kept routes hand the id of the signed-in account to the service (P3-03)', () => {
  const makeController = () => {
    const calls: Array<[string, unknown[]]> = [];
    const service: any = {
      create: async (...args: unknown[]) => (calls.push(['create', args]), {}),
      findByArtisan: async (...args: unknown[]) => (calls.push(['findByArtisan', args]), []),
      completeWork: async (...args: unknown[]) => (calls.push(['completeWork', args]), {}),
    };

    return { controller: new InterventionsController(service), calls };
  };

  it('POST /interventions/secure: the id and the role of req.user (the alias `userId` of the first strategy is gone)', async () => {
    const { controller, calls } = makeController();
    const dto = form('55 111 222');

    await controller.createSecure({ user: { id: 5, role: 'SUPPORT' } }, dto);

    expect(calls).toEqual([['create', [5, dto, 'SUPPORT']]]);
  });

  it('GET /interventions/assigned: the missions of the account that asks', async () => {
    const { controller, calls } = makeController();

    await controller.findAssigned({ user: { id: 20, role: 'ARTISAN' } });

    expect(calls).toEqual([['findByArtisan', [20]]]);
  });

  it('POST /interventions/:id/complete-work: the job of the path, the id and the role of the account, the photo and what was captured', async () => {
    const { controller, calls } = makeController();
    const file = { buffer: Buffer.from('x') } as any;

    await controller.completeWork({ user: { id: 20, role: 'ARTISAN' } }, '12', file, { latitude: '36.8', timestamp: '2026-10-31T10:00:00Z' } as any);

    // No `X-Queued-For` header: the photo was not held by the phone (P3-06), so nothing is taken off its arrival time.
    expect(calls).toEqual([
      ['completeWork', [12, { id: 20, role: 'ARTISAN' }, { file, capture: { latitude: '36.8', timestamp: '2026-10-31T10:00:00Z', capturedAt: '2026-10-31T10:00:00Z' }, queuedForSeconds: 0 }]],
    ]);
  });

  it('POST /interventions/:id/complete-work: the seconds the phone held the photo are read from X-Queued-For, and nothing unreadable is believed (P3-06)', async () => {
    const file = { buffer: Buffer.from('x') } as any;
    const held = async (header?: string) => {
      const { controller, calls } = makeController();

      await controller.completeWork({ user: { id: 20, role: 'ARTISAN' } }, '12', file, { latitude: '36.8', timestamp: '2026-10-31T10:00:00Z' } as any, header);

      return (calls[0][1] as any[])[2].queuedForSeconds;
    };

    expect(await held('3480')).toBe(3480);
    expect(await held(' 95 ')).toBe(95);
    expect(await held('99999999')).toBe(604_800);
    expect(await held('-5')).toBe(0);
    expect(await held('1.5')).toBe(0);
    expect(await held('abc')).toBe(0);
    expect(await held(undefined)).toBe(0);
  });
});
