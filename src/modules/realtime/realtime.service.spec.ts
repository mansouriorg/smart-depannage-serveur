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
