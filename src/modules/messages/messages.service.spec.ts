import { MessagesService } from './messages.service';

function make() {
  const queried: string[] = [];
  const wheres: any[] = [];

  const prisma: any = {
    message: {
      count: async ({ where }: any) => {
        wheres.push(where);
        queried.push(where.audience?.in ? 'all' : String(where.audience));
        return 3;
      },
    },
  };

  return { service: new MessagesService(prisma, {} as any, {} as any), queried, wheres };
}

describe('unread counters only count the chats a role is part of', () => {
  it('a customer sees the artisan chat and the support chat, never the artisan-support chat', async () => {
    const { service, queried } = make();

    const counts = await service.countUnread(10, 'CLIENT' as any);

    expect(counts.byAudience).toEqual({ CLIENT_ARTISAN: 3, CLIENT_SUPPORT: 3, ARTISAN_SUPPORT: 0 });
    expect(queried.includes('ARTISAN_SUPPORT')).toBe(false);
  });

  it('an artisan never gets a number for the customer-support chat', async () => {
    const { service, queried } = make();

    const counts = await service.countUnread(20, 'ARTISAN' as any);

    expect(counts.byAudience).toEqual({ CLIENT_ARTISAN: 3, CLIENT_SUPPORT: 0, ARTISAN_SUPPORT: 3 });
    expect(queried.includes('CLIENT_SUPPORT')).toBe(false);
  });

  it('staff see all three', async () => {
    const { service } = make();

    const counts = await service.countUnread(1, 'SUPPORT' as any);

    expect(counts.byAudience).toEqual({ CLIENT_ARTISAN: 3, CLIENT_SUPPORT: 3, ARTISAN_SUPPORT: 3 });
  });

  it('every count is limited to the caller’s own jobs and never counts their own messages', async () => {
    const customer = make();
    await customer.service.countUnread(10, 'CLIENT' as any);
    for (const where of customer.wheres) {
      expect(where.intervention).toEqual({ clientId: 10 });
      expect(where.senderId).toEqual({ not: 10 });
      expect(where.deletedAt).toBe(null);
    }

    const artisan = make();
    await artisan.service.countUnread(20, 'ARTISAN' as any);
    for (const where of artisan.wheres) {
      expect(where.intervention).toEqual({ artisanId: 20 });
    }
  });

  it('the total only covers the audiences of the role', async () => {
    const customer = make();
    await customer.service.countUnread(10, 'CLIENT' as any);
    expect(customer.wheres[0].audience.in.slice().sort()).toEqual(['CLIENT_ARTISAN', 'CLIENT_SUPPORT']);

    const artisan = make();
    await artisan.service.countUnread(20, 'ARTISAN' as any);
    expect(artisan.wheres[0].audience.in.slice().sort()).toEqual(['ARTISAN_SUPPORT', 'CLIENT_ARTISAN']);
  });
});
