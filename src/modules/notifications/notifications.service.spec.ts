import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { NotificationsService } from './notifications.service';

type User = { id: number; role: string; isActive: boolean; email?: string; phone?: string };

/** An in-memory stand-in for the few Prisma calls the service makes. */
function makeWorld(extra: Partial<{
  users: User[];
  quotes: any[];
  payments: any[];
  messages: any[];
  complaints: any[];
  /** notification preferences by user id (default: everything on) */
  prefs: Record<number, any>;
}> = {}) {
  const users: User[] = extra.users ?? [
    { id: 1, role: 'ADMIN', isActive: true },
    { id: 2, role: 'SUPPORT', isActive: true },
    { id: 3, role: 'ACCOUNTANT', isActive: true },
    { id: 4, role: 'DISPATCHER', isActive: true },
    { id: 5, role: 'SUPER_ADMIN', isActive: true },
    { id: 6, role: 'ADMIN', isActive: false },
    { id: 10, role: 'CLIENT', isActive: true, email: 'client@example.com' },
    { id: 20, role: 'ARTISAN', isActive: true, email: 'artisan@example.com' },
  ];

  const notifications: any[] = [];
  const deliveries: any[] = [];
  const live: Array<{ userId: number; event: string; notificationId: number; notification: any }> = [];
  let nextId = 1;

  const byId = (list: any[], id: number) => list.find((row) => row.id === id) ?? null;

  const prisma: any = {
    user: {
      findUnique: async ({ where }: any) => byId(users, where.id),
      findMany: async ({ where }: any) =>
        users.filter(
          (u) =>
            (where.isActive === undefined || u.isActive === where.isActive) &&
            (!where.role?.in || where.role.in.includes(u.role)),
        ),
    },
    notificationPreference: {
      upsert: async ({ where, create }: any) => ({ ...create, ...(extra.prefs?.[where.userId] ?? {}) }),
    },
    notification: {
      create: async ({ data }: any) => {
        const row = {
          id: nextId++,
          isRead: false,
          readAt: null,
          deletedAt: null,
          ...data,
          recipient: byId(users, data.recipientId),
          actor: data.actorId ? byId(users, data.actorId) : null,
          deliveries: [],
        };
        notifications.push(row);
        return row;
      },
      findUnique: async ({ where }: any) => byId(notifications, where.id),
      update: async ({ where, data }: any) => {
        const row = byId(notifications, where.id);
        Object.assign(row, data);
        return row;
      },
    },
    notificationDeliveryLog: {
      create: async ({ data }: any) => {
        deliveries.push(data);
        return data;
      },
    },
    pushDeviceToken: { findMany: async () => [] },
    quote: {
      findUnique: async ({ where }: any) => byId(extra.quotes ?? [], where.id),
    },
    payment: {
      findUnique: async ({ where }: any) => byId(extra.payments ?? [], where.id),
    },
    message: {
      findUnique: async ({ where }: any) => byId(extra.messages ?? [], where.id),
    },
    complaint: {
      findUnique: async ({ where }: any) => byId(extra.complaints ?? [], where.id),
    },
  };

  const gateway = {
    emitToUser: (userId: number, event: string, payload: any) => {
      live.push({ userId, event, notificationId: payload.notification.id, notification: payload.notification });
    },
  };

  const service = new NotificationsService(prisma, gateway as any);

  return { service, prisma, notifications, deliveries, live, users };
}

async function failure(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('expected the call to fail');
}

const recipients = (notifications: any[]) => notifications.map((n) => n.recipientId).sort((a, b) => a - b);

describe('admin fan-out', () => {
  it('gives every active admin their own notification and one live event each', async () => {
    const { service, notifications, live } = makeWorld();

    const created = await service.notifyAdmins({
      type: 'GENERAL' as any,
      title: 'x',
      message: 'y',
    });

    // admins 1..5 are active (6 is not): five different rows, five different ids
    expect(recipients(created)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(notifications.map((n) => n.id)).size).toBe(5);

    // each admin's socket room got exactly one event, for their own copy
    expect(live.length).toBe(5);
    for (const row of notifications) {
      const mine = live.filter((l) => l.userId === row.recipientId);
      expect(mine.length).toBe(1);
      expect(mine[0].notificationId).toBe(row.id);
      expect(mine[0].event).toBe('notification.new');
    }
  });

  it('sends the live copy once even when IN_APP and ADMIN_REAL_TIME are both asked for', async () => {
    const { service, deliveries, live } = makeWorld();

    await service.notify({
      recipientId: 1,
      type: 'GENERAL' as any,
      title: 'x',
      message: 'y',
      channels: ['IN_APP', 'ADMIN_REAL_TIME'] as any,
    });

    expect(live.length).toBe(1);
    // both channels are still recorded as delivered
    expect(deliveries.map((d) => d.channel).sort()).toEqual(['ADMIN_REAL_TIME', 'IN_APP']);
  });

  it('does not tell an admin about their own action', async () => {
    const { service } = makeWorld();

    const created = await service.notifyAdmins({
      actorId: 1,
      type: 'GENERAL' as any,
      title: 'x',
      message: 'y',
    });

    expect(recipients(created)).toEqual([2, 3, 4, 5]);
  });

  it('can be narrowed to the roles concerned', async () => {
    const { service } = makeWorld();

    const created = await service.notifyAdmins({
      roles: ['ACCOUNTANT'] as any,
      type: 'GENERAL' as any,
      title: 'x',
      message: 'y',
    });

    expect(recipients(created)).toEqual([3]);
  });

  it('one admin failing does not stop the others', async () => {
    const { service, prisma } = makeWorld();
    const original = prisma.notification.create;

    prisma.notification.create = async (args: any) => {
      if (args.data.recipientId === 2) throw new Error('db hiccup');
      return original(args);
    };

    const created = await service.notifyAdmins({
      type: 'GENERAL' as any,
      title: 'x',
      message: 'y',
    });

    expect(recipients(created)).toEqual([1, 3, 4, 5]);
  });
});

describe('who is told about what', () => {
  const quote = {
    id: 7,
    interventionId: 100,
    amountTTC: 120,
    intervention: { id: 100, clientId: 10, artisanId: 20 },
  };

  it('a quote sent: one notification, for the customer', async () => {
    const { service, notifications } = makeWorld({ quotes: [quote] });

    await service.notifyQuoteSent(7, 1);

    expect(notifications.length).toBe(1);
    expect(notifications[0].recipientId).toBe(10);
    expect(notifications[0].type).toBe('QUOTE_SENT');
    expect(notifications[0].channels).toContain('IN_APP');
  });

  it('a quote sent can be limited to the app when other channels already went out', async () => {
    const { service, notifications } = makeWorld({ quotes: [quote] });

    await service.notifyQuoteSent(7, 1, ['IN_APP', 'PUSH'] as any);

    expect(notifications[0].channels).toEqual(['IN_APP', 'PUSH']);
  });

  it('a quote accepted: dispatchers, support and admins, once each, not accountants, and the artisan on the job', async () => {
    const { service, notifications } = makeWorld({ quotes: [quote] });

    await service.notifyQuoteAccepted(7, 10);

    expect(recipients(notifications)).toEqual([1, 2, 4, 5, 20]);
    expect(notifications.filter((n) => n.recipientId === 20).length).toBe(1);
  });

  it('a quote accepted on a job without an artisan only tells the back office', async () => {
    const { service, notifications } = makeWorld({
      quotes: [{ ...quote, intervention: { id: 100, clientId: 10, artisanId: null } }],
    });

    await service.notifyQuoteAccepted(7, 10);

    expect(recipients(notifications)).toEqual([1, 2, 4, 5]);
  });

  it('a payment confirmed: the customer and the money people, not the admin who confirmed it', async () => {
    const payment = {
      id: 9,
      interventionId: 100,
      amount: 50,
      currency: 'EUR',
      intervention: { id: 100, clientId: 10 },
    };
    const { service, notifications } = makeWorld({ payments: [payment] });

    await service.notifyPaymentReceived(9, 1);

    // customer 10, accountant 3, super admin 5; admin 1 clicked, so not 1
    expect(recipients(notifications)).toEqual([3, 5, 10]);
    expect(notifications.filter((n) => n.recipientId === 10).length).toBe(1);
  });

  it('a complaint opened: support and admins', async () => {
    const complaint = { id: 4, interventionId: 100, title: 'Fuite', assignedToId: null };
    const { service, notifications } = makeWorld({ complaints: [complaint] });

    await service.notifyComplaintOpened(4, 10);

    expect(recipients(notifications)).toEqual([1, 2, 5]);
  });

  it('a complaint moved forward: the person who filed it, unless they did it themselves', async () => {
    const complaint = { id: 4, interventionId: 100, title: 'Fuite', assignedToId: null };
    const { service, notifications } = makeWorld({ complaints: [complaint] });

    await service.notifyComplaintUpdated(4, 10, 1);
    await service.notifyComplaintUpdated(4, 10, 10);

    expect(recipients(notifications)).toEqual([10]);
  });

  it('a reply on an assigned complaint goes to the assignee only', async () => {
    const complaint = { id: 4, interventionId: 100, title: 'Fuite', assignedToId: 2 };
    const { service, notifications } = makeWorld({ complaints: [complaint] });

    await service.notifyComplaintReply(4, 10);

    expect(recipients(notifications)).toEqual([2]);
  });

  it('a reply from the customer also tells the artisan, and the other way round', async () => {
    const complaint = {
      id: 4,
      interventionId: 100,
      title: 'Fuite',
      userId: 10,
      assignedToId: 2,
      intervention: { artisanId: 20 },
    };

    const fromClient = makeWorld({ complaints: [complaint] });
    await fromClient.service.notifyComplaintReply(4, 10);
    expect(recipients(fromClient.notifications)).toEqual([2, 20]);

    const fromArtisan = makeWorld({ complaints: [complaint] });
    await fromArtisan.service.notifyComplaintReply(4, 20);
    expect(recipients(fromArtisan.notifications)).toEqual([2, 10]);
  });

  it('a reply goes to the support team when the assignee is no longer active', async () => {
    const complaint = { id: 4, interventionId: 100, title: 'Fuite', assignedToId: 6 };
    const { service, notifications } = makeWorld({ complaints: [complaint] });

    await service.notifyComplaintReply(4, 10);

    // 6 is an inactive admin: the team (1, 2, 5) hears about it instead
    expect(recipients(notifications)).toEqual([1, 2, 5]);
  });

  it('a reply on an unassigned complaint goes to the support team', async () => {
    const complaint = { id: 4, interventionId: 100, title: 'Fuite', assignedToId: null };
    const { service, notifications } = makeWorld({ complaints: [complaint] });

    await service.notifyComplaintReply(4, 10);

    expect(recipients(notifications)).toEqual([1, 2, 5]);
  });
});

describe('new messages', () => {
  const message = (audience: string, senderId: number, senderRole: string, extra: any = {}) => ({
    id: 55,
    interventionId: 100,
    audience,
    senderId,
    content: 'Bonjour',
    deletedAt: null,
    sender: { id: senderId, name: 'Someone', role: senderRole },
    intervention: { id: 100, clientId: 10, artisanId: 20 },
    ...extra,
  });

  const who = async (m: any) => {
    const { service, notifications } = makeWorld({ messages: [m] });
    await service.notifyNewMessage(55);
    return recipients(notifications);
  };

  it('client to artisan: only the artisan, nobody from support', async () => {
    expect(await who(message('CLIENT_ARTISAN', 10, 'CLIENT'))).toEqual([20]);
  });

  it('support to the customer: the customer only, never the artisan', async () => {
    expect(await who(message('CLIENT_SUPPORT', 2, 'SUPPORT'))).toEqual([10]);
  });

  it('support to the artisan: the artisan only, never the customer', async () => {
    expect(await who(message('ARTISAN_SUPPORT', 2, 'SUPPORT'))).toEqual([20]);
  });

  it('the customer writes to support: support and admins, one each, not the artisan', async () => {
    expect(await who(message('CLIENT_SUPPORT', 10, 'CLIENT'))).toEqual([1, 2, 5]);
  });

  it('the artisan writes to support: support and admins, not the customer', async () => {
    expect(await who(message('ARTISAN_SUPPORT', 20, 'ARTISAN'))).toEqual([1, 2, 5]);
  });

  it('a deleted message and an internal note tell nobody', async () => {
    expect(await who(message('CLIENT_ARTISAN', 10, 'CLIENT', { deletedAt: new Date() }))).toEqual([]);
    expect(await who(message('INTERNAL_ADMIN', 2, 'SUPPORT'))).toEqual([]);
  });

  it('shows who wrote it and a short text, or says there is an attachment', async () => {
    const withText = makeWorld({
      messages: [message('CLIENT_ARTISAN', 10, 'CLIENT', { content: 'x'.repeat(300) })],
    });
    await withText.service.notifyNewMessage(55);
    expect(withText.notifications[0].message.startsWith('Someone: ')).toBe(true);
    expect(withText.notifications[0].message.length < 200).toBe(true);

    const attachmentOnly = makeWorld({
      messages: [message('CLIENT_ARTISAN', 10, 'CLIENT', { content: null })],
    });
    await attachmentOnly.service.notifyNewMessage(55);
    expect(attachmentOnly.notifications[0].message).toBe('Someone: Pièce jointe');
  });
});

describe('a notification problem never breaks the action that caused it', () => {
  it('helpers swallow errors', async () => {
    const world = makeWorld();
    world.prisma.quote.findUnique = async () => {
      throw new Error('database is down');
    };
    world.prisma.message.findUnique = async () => {
      throw new Error('database is down');
    };

    expect(await world.service.notifyQuoteSent(7)).toBe(null);
    expect(await world.service.notifyQuoteAccepted(7)).toBe(null);
    expect(await world.service.notifyNewMessage(55)).toBe(null);
  });
});

describe('the notification centre', () => {
  it('the recipient can mark their own notification as read, an admin cannot mark someone else’s', async () => {
    const { service, notifications } = makeWorld();
    await service.notifyAdmins({ type: 'GENERAL' as any, title: 'x', message: 'y' });

    const adminOne = notifications.find((n) => n.recipientId === 1)!;
    const adminTwoUser = { id: 2, role: 'SUPPORT' as any };

    const error = await failure(service.markAsRead(adminTwoUser, adminOne.id));
    expect(error instanceof ForbiddenException).toBe(true);
    expect(adminOne.isRead).toBe(false);

    const read = await service.markAsRead({ id: 1, role: 'ADMIN' as any }, adminOne.id);
    expect(read.isRead).toBe(true);

    // admin 2's copy is untouched
    expect(notifications.find((n) => n.recipientId === 2)!.isRead).toBe(false);
  });

  it('nobody else can delete it, and only an admin or super admin can look at it', async () => {
    const { service, notifications } = makeWorld();
    await service.notify({ recipientId: 10, type: 'GENERAL' as any, title: 'x', message: 'y' });
    const row = notifications[0];

    const error = await failure(service.deleteNotification({ id: 1, role: 'ADMIN' as any }, row.id));
    expect(error instanceof ForbiddenException).toBe(true);

    // admin / super admin: the back office view, with the recipient and the delivery log
    const seen = await service.findOne({ id: 1, role: 'ADMIN' as any }, row.id);
    expect(seen.id).toBe(row.id);
    expect((seen as any).recipient.id).toBe(10);
    expect((await service.findOne({ id: 5, role: 'SUPER_ADMIN' as any }, row.id)).id).toBe(row.id);

    // the other back-office roles and strangers: refused
    for (const user of [
      { id: 2, role: 'SUPPORT' },
      { id: 3, role: 'ACCOUNTANT' },
      { id: 4, role: 'DISPATCHER' },
      { id: 20, role: 'ARTISAN' },
    ]) {
      const refused = await failure(service.findOne(user as any, row.id));
      expect(refused instanceof ForbiddenException).toBe(true);
    }
  });

  it('the recipient gets a plain view: no recipient record, no delivery log, no e-mail of the sender', async () => {
    const { service, notifications, live } = makeWorld();
    await service.notify({
      recipientId: 10,
      actorId: 2,
      type: 'GENERAL' as any,
      title: 'x',
      message: 'y',
    });
    const row = notifications[0];
    row.actor = { id: 2, name: 'Sam', email: 'sam@staff.example', phone: '+216 1', role: 'SUPPORT' };

    const mine = (await service.findOne({ id: 10, role: 'CLIENT' as any }, row.id)) as any;
    expect(mine.recipient).toBe(undefined);
    expect(mine.deliveries).toBe(undefined);
    expect(mine.actor).toEqual({ id: 2, name: 'Sam', role: 'SUPPORT' });

    // and so does the live event
    const pushed = live[0].notification;
    expect(pushed.recipient).toBe(undefined);
    expect(pushed.deliveries).toBe(undefined);
    expect(pushed.actor.email).toBe(undefined);
    expect(pushed.title).toBe('x');
  });

  it('a user who turned a kind of notification off, or every channel, gets nothing', async () => {
    const eventOff = makeWorld({ prefs: { 10: { quoteSent: false } } });
    expect(await eventOff.service.notify({ recipientId: 10, type: 'QUOTE_SENT' as any, title: 'x', message: 'y' })).toBe(null);

    const inAppOff = makeWorld({ prefs: { 10: { inAppEnabled: false } } });
    expect(
      await inAppOff.service.notify({
        recipientId: 10,
        type: 'QUOTE_SENT' as any,
        title: 'x',
        message: 'y',
        channels: ['IN_APP'] as any,
      }),
    ).toBe(null);
    expect(inAppOff.notifications.length).toBe(0);
  });

  it('POST /notifications says so when nothing was created', async () => {
    const { service } = makeWorld();

    const error = await failure(
      service.create(
        {
          recipientId: 999,
          type: 'GENERAL' as any,
          title: 'x',
          message: 'y',
        } as any,
        { id: 1, role: 'ADMIN' as any },
      ),
    );

    expect(error instanceof NotFoundException).toBe(true);
  });

  it('POST /notifications is always sent by the caller, whatever actorId the body says', async () => {
    const { service, notifications } = makeWorld();

    await service.create(
      { recipientId: 10, actorId: 99999, type: 'GENERAL' as any, title: 'x', message: 'y' } as any,
      { id: 1, role: 'ADMIN' as any },
    );

    expect(notifications[0].actorId).toBe(1);
  });

  it('PATCH: the admin who sent it or a super admin can correct it, nobody else', async () => {
    const { service, notifications } = makeWorld();
    await service.notify({ recipientId: 10, actorId: 1, type: 'GENERAL' as any, title: 'x', message: 'y' });
    const row = notifications[0];

    await service.update({ id: 1, role: 'ADMIN' as any }, row.id, { message: 'corrected' } as any);
    expect(row.message).toBe('corrected');

    await service.update({ id: 5, role: 'SUPER_ADMIN' as any }, row.id, { message: 'again' } as any);
    expect(row.message).toBe('again');

    for (const user of [
      { id: 2, role: 'SUPPORT' },
      { id: 6, role: 'ADMIN' },
    ]) {
      const refused = await failure(service.update(user as any, row.id, { message: 'forged' } as any));
      expect(refused instanceof ForbiddenException).toBe(true);
    }
    expect(row.message).toBe('again');
  });

  it('PATCH cannot change the read state of somebody else’s copy', async () => {
    const { service, notifications } = makeWorld();
    await service.notifyAdmins({ actorId: 5, type: 'GENERAL' as any, title: 'x', message: 'y' });
    const adminOne = notifications.find((n) => n.recipientId === 1)!;

    // super admin 5 sent it, so can edit it, but not mark admin 1's copy as read
    const refused = await failure(
      service.update({ id: 5, role: 'SUPER_ADMIN' as any }, adminOne.id, { isRead: true } as any),
    );
    expect(refused instanceof ForbiddenException).toBe(true);
    expect(adminOne.isRead).toBe(false);
  });

  it('PATCH by the recipient can mark a notification unread again and clears the read time', async () => {
    const { service, notifications } = makeWorld();
    await service.notify({ recipientId: 1, actorId: 1, type: 'GENERAL' as any, title: 'x', message: 'y' });
    const row = notifications[0];
    const admin = { id: 1, role: 'ADMIN' as any };

    await service.update(admin, row.id, { isRead: true } as any);
    expect(row.isRead).toBe(true);
    expect(row.readAt instanceof Date).toBe(true);

    await service.update(admin, row.id, { isRead: false } as any);
    expect(row.isRead).toBe(false);
    expect(row.readAt).toBe(null);
  });
});
