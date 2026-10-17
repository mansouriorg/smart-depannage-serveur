import { RealtimeService } from './realtime.service';

function run(audience: string, artisanId: number | null = 20) {
  const calls: Array<{ to: string; id?: number; event: string }> = [];

  const prisma: any = {
    message: {
      findUnique: async () => ({
        id: 55,
        interventionId: 100,
        audience,
        content: 'Bonjour',
        attachments: [],
        createdAt: new Date(0),
        sender: { id: 99, name: 'Sender', email: 's@example.com', role: 'SUPPORT' },
        intervention: { id: 100, clientId: 10, artisanId, status: 'ASSIGNED' },
      }),
    },
  };

  const gateway: any = {
    emitToClient: (id: number, event: string) => calls.push({ to: 'client', id, event }),
    emitToArtisan: (id: number, event: string) => calls.push({ to: 'artisan', id, event }),
    emitToAdmins: (event: string) => calls.push({ to: 'admins', event }),
    emitToIntervention: (id: number, event: string) => calls.push({ to: 'intervention', id, event }),
    emitToUser: (id: number, event: string) => calls.push({ to: 'user', id, event }),
  };

  const service = new RealtimeService(prisma, gateway);

  return { service, calls };
}

describe('a new message is pushed only to the people in that chat', () => {
  it('client-artisan chat: both of them, plus the dashboard', async () => {
    const { service, calls } = run('CLIENT_ARTISAN');
    await service.emitNewMessage(55);

    expect(calls).toEqual([
      { to: 'client', id: 10, event: 'message.created' },
      { to: 'artisan', id: 20, event: 'message.created' },
      { to: 'admins', event: 'admin.message.created' },
    ]);
  });

  it('client-support chat: the customer, never the artisan', async () => {
    const { service, calls } = run('CLIENT_SUPPORT');
    await service.emitNewMessage(55);

    expect(calls.some((c) => c.to === 'artisan')).toBe(false);
    expect(calls.filter((c) => c.to === 'client').length).toBe(1);
    expect(calls.filter((c) => c.to === 'admins').length).toBe(1);
  });

  it('artisan-support chat: the artisan, never the customer', async () => {
    const { service, calls } = run('ARTISAN_SUPPORT');
    await service.emitNewMessage(55);

    expect(calls.some((c) => c.to === 'client')).toBe(false);
    expect(calls.filter((c) => c.to === 'artisan').length).toBe(1);
  });

  it('never uses the intervention room, where everybody would see every chat', async () => {
    for (const audience of ['CLIENT_ARTISAN', 'CLIENT_SUPPORT', 'ARTISAN_SUPPORT']) {
      const { service, calls } = run(audience);
      await service.emitNewMessage(55);
      expect(calls.some((c) => c.to === 'intervention')).toBe(false);
    }
  });

  it('no artisan assigned yet: nothing is sent to an artisan', async () => {
    const { service, calls } = run('CLIENT_ARTISAN', null);
    await service.emitNewMessage(55);

    expect(calls.some((c) => c.to === 'artisan')).toBe(false);
  });

  it('an audience that is not a chat (internal notes) only reaches the dashboard', async () => {
    const { service, calls } = run('INTERNAL_ADMIN');
    await service.emitNewMessage(55);

    expect(calls.map((c) => c.to)).toEqual(['admins']);
  });
});

describe('a status change is pushed without the back-office columns (P1-06)', () => {
  const row = {
    id: 100,
    clientId: 10,
    artisanId: 20,
    status: 'ACCEPTED',
    adminInternalNotes: 'client difficile, prévenir avant',
    adminReviewStartedAt: new Date(0),
    trackingToken: 'hash-of-the-link',
    cancelledById: 99,
    client: { id: 10, name: 'Sami', email: 's@example.com', phone: '20111222' },
    artisan: { id: 20, name: 'Karim', email: 'k@example.com', phone: '20333444' },
  };

  function make(artisanId: number | null = 20) {
    const sent: Array<{ to: string; id?: number; event: string; payload: any }> = [];
    const prisma: any = { intervention: { findUnique: async () => ({ ...row, artisanId }) } };
    const gateway: any = {
      emitToClient: (id: number, event: string, payload: any) => sent.push({ to: 'client', id, event, payload }),
      emitToArtisan: (id: number, event: string, payload: any) => sent.push({ to: 'artisan', id, event, payload }),
      emitToAdmins: (event: string, payload: any) => sent.push({ to: 'admins', event, payload }),
      emitToIntervention: (id: number, event: string, payload: any) => sent.push({ to: 'room', id, event, payload }),
    };

    return { service: new RealtimeService(prisma, gateway), sent };
  }

  const STAFF_ONLY = ['adminInternalNotes', 'adminReviewStartedAt', 'trackingToken', 'cancelledById'];

  it('the client, the artisan and the room of the job never get the staff notes or the hash of the tracking link', async () => {
    const { service, sent } = make();

    await service.emitStatusChange({ interventionId: 100, oldStatus: 'ASSIGNED', newStatus: 'ACCEPTED', actorId: 20 });

    const people = sent.filter((s) => s.to !== 'admins');

    expect(people.map((s) => s.to).sort()).toEqual(['artisan', 'client', 'room']);

    for (const message of people) {
      for (const field of STAFF_ONLY) {
        expect(field in message.payload.intervention).toBe(false);
      }

      expect(message.payload.intervention.status).toBe('ACCEPTED');
      expect(message.payload.newStatus).toBe('ACCEPTED');
      expect(message.event).toBe('intervention.status.changed');
    }
  });

  it('the people of the job are not told who made the change (a client must not learn which artisan gave the job back); the dashboard is', async () => {
    const { service, sent } = make(null);

    await service.emitStatusChange({ interventionId: 100, oldStatus: 'ACCEPTED', newStatus: 'ADMIN_REVIEW', actorId: 20 });

    for (const message of sent.filter((s) => s.to !== 'admins')) {
      expect('actorId' in message.payload).toBe(false);
      expect(JSON.stringify(message.payload)).not.toMatch(/"actorId"/);
      // The rest of the event is whole.
      expect(message.payload.interventionId).toBe(100);
      expect(message.payload.oldStatus).toBe('ACCEPTED');
      expect(message.payload.newStatus).toBe('ADMIN_REVIEW');
    }

    expect(sent.find((s) => s.to === 'admins')!.payload.actorId).toBe(20);
  });

  it('the dashboard still gets the whole row', async () => {
    const { service, sent } = make();

    await service.emitStatusChange({ interventionId: 100, oldStatus: 'ASSIGNED', newStatus: 'ACCEPTED', actorId: 20 });

    const admins = sent.filter((s) => s.to === 'admins');

    expect(admins).toHaveLength(1);
    expect(admins[0].event).toBe('admin.intervention.status.changed');
    expect(admins[0].payload.intervention.adminInternalNotes).toBe('client difficile, prévenir avant');
    expect(admins[0].payload.intervention.trackingToken).toBe('hash-of-the-link');
  });

  it('the row of the database is not changed by the removal', async () => {
    const { service } = make();

    await service.emitStatusChange({ interventionId: 100, newStatus: 'ACCEPTED' });

    expect(row.adminInternalNotes).toBe('client difficile, prévenir avant');
  });

  it('a job without an artisan (given back) is sent to the client, the room and the dashboard only', async () => {
    const { service, sent } = make(null);

    await service.emitStatusChange({ interventionId: 100, oldStatus: 'ACCEPTED', newStatus: 'ADMIN_REVIEW', actorId: 20 });

    expect(sent.map((s) => s.to).sort()).toEqual(['admins', 'client', 'room']);
  });

  it('nothing is sent for a job that does not exist', async () => {
    const sent: any[] = [];
    const service = new RealtimeService(
      { intervention: { findUnique: async () => null } } as any,
      { emitToClient: () => sent.push(1), emitToArtisan: () => sent.push(1), emitToAdmins: () => sent.push(1), emitToIntervention: () => sent.push(1) } as any,
    );

    expect(await service.emitStatusChange({ interventionId: 5, newStatus: 'ACCEPTED' })).toBe(null);
    expect(sent).toEqual([]);
  });
});

describe('RealtimeService.removeFromJobRoom', () => {
  it('asks the gateway to take the artisan out of the room of the job', () => {
    const removed: any[] = [];
    const gateway: any = { removeUserFromIntervention: (...args: any[]) => removed.push(args) };
    const service = new RealtimeService({} as any, gateway);

    service.removeFromJobRoom(20, 5);

    expect(removed).toEqual([[20, 5]]);
  });
});
