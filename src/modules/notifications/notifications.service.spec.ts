import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { NotificationsService } from './notifications.service';
import { MessageTemplatesService } from './delivery/message-templates.service';

type User = { id: number; role: string; isActive: boolean; email?: string; phone?: string; name?: string };

/** An in-memory stand-in for the few Prisma calls the service makes. */
function makeWorld(extra: Partial<{
  users: User[];
  quotes: any[];
  interventions: any[];
  payments: any[];
  messages: any[];
  complaints: any[];
  /** notification preferences by user id (default: everything on) */
  prefs: Record<number, any>;
  /** NotificationTemplate rows by key */
  templates: Record<string, any>;
  emailConfigured: boolean;
  smsConfigured: boolean;
  pushConfigured: boolean;
  /** make the outbox refuse to queue */
  outboxDown: boolean;
  /** NotificationOutbox rows by id */
  outboxRows: Record<number, any>;
}> = {}) {
  const users: User[] = extra.users ?? [
    { id: 1, role: 'ADMIN', isActive: true },
    { id: 2, role: 'SUPPORT', isActive: true },
    { id: 3, role: 'ACCOUNTANT', isActive: true },
    { id: 4, role: 'DISPATCHER', isActive: true },
    { id: 5, role: 'SUPER_ADMIN', isActive: true },
    { id: 6, role: 'ADMIN', isActive: false },
    { id: 10, role: 'CLIENT', isActive: true, email: 'client@example.com', name: 'Sami' },
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
        const row = { id: deliveries.length + 1, ...data };
        deliveries.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = byId(deliveries, where.id);
        Object.assign(row, data);
        return row;
      },
    },
    notificationOutbox: {
      findUnique: async ({ where }: any) => extra.outboxRows?.[where.id] ?? null,
    },
    notificationTemplate: {
      findUnique: async ({ where }: any) => extra.templates?.[where.key] ?? null,
    },
    pushDeviceToken: { findMany: async () => [] },
    quote: {
      findUnique: async ({ where }: any) => byId(extra.quotes ?? [], where.id),
    },
    intervention: {
      findUnique: async ({ where }: any) => byId(extra.interventions ?? [], where.id),
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

  // What the outbox was asked to send, in place of the real one.
  const queued: any[] = [];
  const outbox: any = {
    enqueue: async (input: any) => {
      if (extra.outboxDown) throw new Error('database is down');
      queued.push(input);
      return { id: queued.length };
    },
    isEmailConfigured: () => extra.emailConfigured ?? false,
    isSmsConfigured: () => extra.smsConfigured ?? false,
    isPushConfigured: () => extra.pushConfigured ?? false,
    providerName: () => 'FAKE',
  };

  const service = new NotificationsService(prisma, gateway as any, outbox, new MessageTemplatesService(prisma));

  const logLines: string[] = [];
  (service as any).logger = {
    log: (line: string) => logLines.push(line),
    warn: (line: string) => logLines.push(line),
    error: (line: string) => logLines.push(line),
  };

  return { service, prisma, notifications, deliveries, live, users, queued, logLines };
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

describe('e-mail, SMS and push go through the outbox', () => {
  const channelsOf = (...channels: string[]) => ({
    recipientId: 10,
    type: 'QUOTE_SENT' as any,
    title: 'Nouveau devis',
    message: 'Votre devis est prêt.',
    channels: channels as any,
    data: { quoteId: 7 },
  });

  it('an e-mail is queued, and its delivery log starts as PENDING', async () => {
    const { service, queued, deliveries, notifications } = makeWorld();

    await service.notify(channelsOf('EMAIL'));

    expect(queued.length).toBe(1);
    expect(queued[0]).toEqual({
      channel: 'EMAIL',
      userId: 10,
      recipient: 'client@example.com',
      subject: 'Nouveau devis',
      body: 'Votre devis est prêt.',
      data: undefined,
      notificationId: notifications[0].id,
      deliveryLogId: deliveries[0].id,
    });
    expect(deliveries[0].status).toBe('PENDING');
    expect(deliveries[0].provider).toBe('OUTBOX');
    expect(deliveries[0].destination).toBe('client@example.com');
  });

  it('no address, no number: skipped, nothing queued', async () => {
    const { service, queued, deliveries } = makeWorld();

    await service.notify(channelsOf('SMS'));
    await service.notify({ ...channelsOf('EMAIL'), recipientId: 5 });

    expect(queued.length).toBe(0);
    expect(deliveries.map((d) => d.status)).toEqual(['SKIPPED', 'SKIPPED']);
  });

  it('an SMS goes to the phone of the recipient', async () => {
    const { service, queued } = makeWorld({
      users: [{ id: 10, role: 'CLIENT', isActive: true, phone: '22123456' }],
    });

    await service.notify(channelsOf('SMS'));

    expect(queued[0].channel).toBe('SMS');
    expect(queued[0].recipient).toBe('22123456');
  });

  it('a push is queued for the user, with the data of the notification', async () => {
    const { service, queued } = makeWorld();

    await service.notify(channelsOf('PUSH'));

    expect(queued[0].channel).toBe('PUSH');
    expect(queued[0].userId).toBe(10);
    expect(queued[0].recipient).toBe(undefined);
    expect(queued[0].data).toEqual({ quoteId: 7 });
  });

  it('in-app notifications do not touch the outbox', async () => {
    const { service, queued } = makeWorld();

    await service.notify(channelsOf('IN_APP', 'ADMIN_REAL_TIME'));

    expect(queued.length).toBe(0);
  });

  it('the wording comes from the NotificationTemplate for this type and channel', async () => {
    const { service, queued } = makeWorld({
      templates: {
        'QUOTE_SENT.EMAIL': {
          key: 'QUOTE_SENT.EMAIL',
          type: 'EMAIL',
          isActive: true,
          subject: 'Devis n°{{quoteId}}',
          content: 'Bonjour {{recipientName}}, {{message}} (devis {{quoteId}})',
        },
      },
    });

    await service.notify(channelsOf('EMAIL'));

    expect(queued[0].subject).toBe('Devis n°7');
    expect(queued[0].body).toBe('Bonjour Sami, Votre devis est prêt. (devis 7)');
  });

  it('a template that is inactive, or of another channel, is ignored', async () => {
    const { service, queued } = makeWorld({
      templates: {
        'QUOTE_SENT.EMAIL': { key: 'QUOTE_SENT.EMAIL', type: 'SMS', isActive: true, content: 'wrong type' },
      },
    });

    await service.notify(channelsOf('EMAIL'));

    expect(queued[0].subject).toBe('Nouveau devis');
    expect(queued[0].body).toBe('Votre devis est prêt.');
  });

  it('the outbox being down fails that channel in the delivery log, not the notification', async () => {
    const { service, deliveries, notifications, logLines } = makeWorld({ outboxDown: true });

    const created = await service.notify(channelsOf('IN_APP', 'EMAIL'));

    expect(created.id).toBe(notifications[0].id);
    expect(deliveries.map((d) => `${d.channel}:${d.status}`)).toContain('IN_APP:SENT');

    // one e-mail log, closed as FAILED: no PENDING row is left looking like a message in flight
    const mailLogs = deliveries.filter((d) => d.channel === 'EMAIL');
    expect(mailLogs.length).toBe(1);
    expect(mailLogs[0].status).toBe('FAILED');
    expect(mailLogs[0].error).toBe('Could not be queued (Error).');
    expect(deliveries.some((d) => d.status === 'PENDING')).toBe(false);

    // what the database said (which could repeat the message) is not kept anywhere
    expect(mailLogs[0].error).not.toContain('database is down');
    for (const line of logLines) {
      expect(line).not.toContain('database is down');
      expect(line).not.toContain('Votre devis');
    }
  });
});

describe('guests have no mailbox', () => {
  const guest = {
    id: 30,
    role: 'CLIENT',
    isActive: true,
    name: 'Invité',
    email: 'guest_0b6e1f6a-1d1e-4c5b-9a53-2f9a7f3f0c11@guest.smart-depannage.local',
    phone: '22123456',
  };

  const quote = (channels: string[]) => ({
    recipientId: 30,
    type: 'QUOTE_SENT' as any,
    title: 'Nouveau devis',
    message: 'Votre devis est prêt.',
    channels: channels as any,
  });

  it('nothing is mailed to the made-up address; the text goes to the phone instead', async () => {
    const { service, queued, deliveries } = makeWorld({ users: [guest] });

    await service.notify(quote(['EMAIL']));

    expect(queued.length).toBe(1);
    expect(queued[0].channel).toBe('SMS');
    expect(queued[0].recipient).toBe('22123456');
    expect(deliveries.map((d) => `${d.channel}:${d.status}`)).toEqual(['EMAIL:SKIPPED', 'SMS:PENDING']);
  });

  it('no second SMS when the notification already asked for one', async () => {
    const { service, queued } = makeWorld({ users: [guest] });

    await service.notify(quote(['EMAIL', 'SMS']));

    expect(queued.map((q) => q.channel)).toEqual(['SMS']);
  });

  it('no SMS either when the person turned SMS off, or has no phone', async () => {
    const off = makeWorld({ users: [guest], prefs: { 30: { smsEnabled: false } } });
    await off.service.notify(quote(['EMAIL']));
    expect(off.queued.length).toBe(0);

    const noPhone = makeWorld({ users: [{ ...guest, phone: undefined }] });
    await noPhone.service.notify(quote(['EMAIL']));
    expect(noPhone.queued.length).toBe(0);
    expect(noPhone.deliveries.map((d) => d.status)).toEqual(['SKIPPED']);
  });
});

describe('direct e-mail and SMS (codes, links)', () => {
  it('queues the message and says where it went', async () => {
    const { service, queued } = makeWorld();

    const sms = await service.sendSms('22123456', 'Votre code est 482913', { userId: 10 });
    const mail = await service.sendEmail('a@b.tn', 'Sujet', 'Lien: https://x.tn/?token=AAA');

    expect(sms).toEqual({ queued: true, outboxId: 1, provider: 'FAKE' });
    expect(mail.queued).toBe(true);
    expect(queued[0]).toEqual({ channel: 'SMS', recipient: '22123456', body: 'Votre code est 482913', userId: 10 });
    expect(queued[1].subject).toBe('Sujet');
  });

  it('uses a template for the key when there is one, the given text otherwise', async () => {
    const withTemplate = makeWorld({
      templates: {
        'auth.phone_code': { key: 'auth.phone_code', type: 'SMS', isActive: true, content: 'Smart Dépannage: {{code}}' },
      },
    });
    await withTemplate.service.sendSms('22123456', 'fallback', { template: { key: 'auth.phone_code', vars: { code: '482913' } } });
    expect(withTemplate.queued[0].body).toBe('Smart Dépannage: 482913');

    const without = makeWorld();
    await without.service.sendSms('22123456', 'fallback 482913', { template: { key: 'auth.phone_code', vars: { code: '482913' } } });
    expect(without.queued[0].body).toBe('fallback 482913');
  });

  it('a queue failure never throws into the flow that asked (and says it was not queued)', async () => {
    const { service, logLines } = makeWorld({ outboxDown: true });

    const sms = await service.sendSms('22123456', 'Votre code est 482913');
    const mail = await service.sendEmail('a@b.tn', 's', 'c');

    expect(sms.queued).toBe(false);
    expect(mail.queued).toBe(false);
    expect(logLines.length).toBe(2);
    for (const line of logLines) {
      expect(line).not.toContain('database is down');
      expect(line).not.toContain('482913');
    }
  });

  it('a message can expire and can replace the ones before it; without options the row has neither', async () => {
    const { service, queued } = makeWorld();
    const before = Date.now();

    await service.sendSms('22123456', 'Code 111111', { userId: 10, validForMs: 600_000, replaces: 'auth:PHONE_VERIFICATION:10' });
    await service.sendEmail('a@b.tn', 'S', 'C', { replaces: 'auth:EMAIL_VERIFICATION:10' });
    await service.sendSms('22123456', 'Autre');

    expect(queued[0].supersedeKey).toBe('auth:PHONE_VERIFICATION:10');
    expect(queued[0].expiresAt.getTime() - before).toBeGreaterThan(599_000);
    expect(601_000 > queued[0].expiresAt.getTime() - before).toBe(true);
    expect(queued[1].supersedeKey).toBe('auth:EMAIL_VERIFICATION:10');
    expect(queued[1].expiresAt).toBeUndefined();
    expect('expiresAt' in queued[2]).toBe(false);
    expect('supersedeKey' in queued[2]).toBe(false);
  });

  it('tells the flows whether anything can be sent yet', () => {
    const off = makeWorld().service;
    expect(off.isEmailSimulated()).toBe(true);
    expect(off.isSmsSimulated()).toBe(true);

    const on = makeWorld({ emailConfigured: true, smsConfigured: true }).service;
    expect(on.isEmailSimulated()).toBe(false);
    expect(on.isSmsSimulated()).toBe(false);
  });
});

describe('admin delivery checks', () => {
  const admin = { id: 1, role: 'ADMIN' as any };

  it('the test message goes to the caller, only when the channel is set up', async () => {
    const users = [
      { id: 1, role: 'ADMIN', isActive: true, email: 'admin@smart-depannage.tn', phone: '22123456' },
    ];
    const off = makeWorld({ users });

    expect((await failure(off.service.testDelivery(admin, 'EMAIL'))).message).toContain('SMTP_HOST');
    expect((await failure(off.service.testDelivery(admin, 'SMS'))).message).toContain('SMS_PROVIDER');
    expect((await failure(off.service.testDelivery(admin, 'PUSH'))).message).toContain('PUSH_PROVIDER');
    expect(off.queued.length).toBe(0);

    const on = makeWorld({ users, emailConfigured: true, smsConfigured: true, pushConfigured: true });
    const mail = await on.service.testDelivery(admin, 'EMAIL');
    await on.service.testDelivery(admin, 'SMS');
    await on.service.testDelivery(admin, 'PUSH');

    expect(mail.queued).toBe(true);
    expect(on.queued.map((q) => q.channel)).toEqual(['EMAIL', 'SMS', 'PUSH']);
    expect(on.queued[0].recipient).toBe('admin@smart-depannage.tn');
    expect(on.queued[1].recipient).toBe('22123456');
    expect(on.queued[2].userId).toBe(1);
  });

  it('an account without a usable address or number is told so', async () => {
    const users = [{ id: 1, role: 'ADMIN', isActive: true, email: 'admin_1@guest.smart-depannage.local' }];
    const { service } = makeWorld({ users, emailConfigured: true, smsConfigured: true });

    expect((await failure(service.testDelivery(admin, 'EMAIL'))).message).toContain('adresse e-mail');
    expect((await failure(service.testDelivery(admin, 'SMS'))).message).toContain('téléphone');
  });

  it('the status of a queued message shows what happened, never the text or the address', async () => {
    const { service } = makeWorld({
      outboxRows: { 7: { id: 7, channel: 'SMS', status: 'PENDING', attempts: 1, lastError: 'SMS gateway refused (HTTP 503)' } },
    });

    const status = await service.outboxStatus(7);

    expect(status.status).toBe('PENDING');
    expect(status.lastError).toBe('SMS gateway refused (HTTP 503)');
    expect('body' in status).toBe(false);
    expect('recipient' in status).toBe(false);
    expect((await failure(service.outboxStatus(8))) instanceof NotFoundException).toBe(true);
  });

  it('an edited template is used by the next message, not a minute later', async () => {
    const templates: Record<string, any> = {};
    const { service, queued } = makeWorld({ templates });

    await service.sendSms('22123456', 'built-in', { template: { key: 'QUOTE_SENT.SMS' } });
    templates['QUOTE_SENT.SMS'] = { key: 'QUOTE_SENT.SMS', type: 'SMS', isActive: true, content: 'edited by an admin' };

    await service.sendSms('22123456', 'built-in', { template: { key: 'QUOTE_SENT.SMS' } });
    expect(queued[1].body).toBe('built-in'); // still cached

    service.clearTemplateCache();
    await service.sendSms('22123456', 'built-in', { template: { key: 'QUOTE_SENT.SMS' } });
    expect(queued[2].body).toBe('edited by an admin');
  });
});

describe('the steps of a mission tell the client and the back office (P1-06)', () => {
  const job = { id: 100, clientId: 10, artisanId: 20 };
  const named = (name: string | undefined) => [
    { id: 1, role: 'ADMIN', isActive: true },
    { id: 2, role: 'SUPPORT', isActive: true },
    { id: 3, role: 'ACCOUNTANT', isActive: true },
    { id: 4, role: 'DISPATCHER', isActive: true },
    { id: 5, role: 'SUPER_ADMIN', isActive: true },
    { id: 6, role: 'ADMIN', isActive: false },
    { id: 10, role: 'CLIENT', isActive: true, email: 'client@example.com', name: 'Sami' },
    { id: 20, role: 'ARTISAN', isActive: true, email: 'artisan@example.com', name },
  ];

  const steps = [
    { call: 'notifyArtisanAcceptedMission', type: 'ARTISAN_ACCEPTED_MISSION', staff: /a accepté la mission #100/, client: /a accepté votre intervention/ },
    { call: 'notifyArtisanOnTheWay', type: 'ARTISAN_ON_THE_WAY', staff: /est en route pour la mission #100/, client: /Votre artisan .*est en route/ },
    { call: 'notifyArtisanArrived', type: 'ARTISAN_ARRIVED', staff: /est arrivé sur place \(mission #100\)/, client: /Votre artisan .*est arrivé sur place/ },
  ] as const;

  it.each(steps.map((step) => step.call))('%s: dispatchers, support and admins, and the client; not the accountant, not the artisan who did it', async (call) => {
    const { service, notifications } = makeWorld({ users: named('Karim') as any, interventions: [job] });

    await (service as any)[call](100, 20);

    expect(recipients(notifications)).toEqual([1, 2, 4, 5, 10]);
  });

  for (const step of steps) {
    it(`${step.call}: names the artisan, points at the mission and reaches the client by SMS too`, async () => {
      const { service, notifications } = makeWorld({ users: named('Karim') as any, interventions: [job] });

      await (service as any)[step.call](100, 20);

      const toClient = notifications.find((n) => n.recipientId === 10);
      const toStaff = notifications.find((n) => n.recipientId === 1);

      expect(toClient.type).toBe(step.type);
      expect(toClient.message).toMatch(step.client);
      expect(toClient.message).toMatch(/Karim/);
      expect(toClient.channels).toContain('SMS');
      expect(toClient.entityType).toBe('INTERVENTION');
      expect(toClient.entityId).toBe(100);
      expect(toClient.actorId).toBe(20);
      expect(toStaff.message).toMatch(step.staff);
      expect(toStaff.message).toMatch(/Karim/);
      expect(toStaff.channels).toEqual(['IN_APP', 'ADMIN_REAL_TIME']);
      expect(toStaff.data).toEqual({ interventionId: 100, artisanId: 20 });
    });

    it(`${step.call}: an artisan with no name is still told about ("L’artisan")`, async () => {
      const { service, notifications } = makeWorld({ users: named(undefined) as any, interventions: [job] });

      await (service as any)[step.call](100, 20);

      expect(notifications.find((n) => n.recipientId === 1).message).toMatch(/^L’artisan /);
      expect(notifications.find((n) => n.recipientId === 10).message).not.toMatch(/undefined|null|\s{2}/);
    });

    it(`${step.call}: a mission that does not exist tells nobody`, async () => {
      const { service, notifications } = makeWorld({ users: named('Karim') as any, interventions: [] });

      expect(await (service as any)[step.call](100, 20)).toBe(null);
      expect(notifications).toHaveLength(0);
    });
  }

  it('a refusal: the back office is told at high priority, with the reason; the client is told another artisan is being found, without the reason', async () => {
    const { service, notifications } = makeWorld({ users: named('Karim') as any, interventions: [job] });

    await service.notifyArtisanDeclined(100, 20, 'trop loin: À 80 km');

    expect(recipients(notifications)).toEqual([1, 2, 4, 5, 10]);

    const toStaff = notifications.find((n) => n.recipientId === 1);
    const toClient = notifications.find((n) => n.recipientId === 10);

    expect(toStaff.type).toBe('GENERAL');
    expect(toStaff.priority).toBe('HIGH');
    expect(toStaff.title).toBe('Mission refusée');
    expect(toStaff.message).toBe('Karim a refusé la mission #100 (trop loin: À 80 km). Elle attend un nouvel artisan.');

    expect(toClient.title).toBe('Nouvel artisan en recherche');
    expect(toClient.message).toBe('Votre artisan n’est plus disponible pour cette intervention. Nous en cherchons un autre et revenons vers vous.');
    expect(toClient.channels).toEqual(['IN_APP', 'PUSH', 'SMS']);
    expect(`${toClient.title} ${toClient.message} ${JSON.stringify(toClient.data)}`).not.toMatch(/loin|80 km|Karim/);
  });

  it('a refusal without a reason still reads well', async () => {
    const { service, notifications } = makeWorld({ users: named('Karim') as any, interventions: [job] });

    await service.notifyArtisanDeclined(100, 20);

    expect(notifications.find((n) => n.recipientId === 1).message).toBe('Karim a refusé la mission #100. Elle attend un nouvel artisan.');
  });

  it('an inactive back-office account is not told', async () => {
    const { service, notifications } = makeWorld({ users: named('Karim') as any, interventions: [job] });

    await service.notifyArtisanOnTheWay(100, 20);

    expect(notifications.some((n) => n.recipientId === 6)).toBe(false);
  });

  it('a refusal: the client\'s copy does not say who the artisan was (no actor, no artisan id); the back office\'s copy does', async () => {
    const { service, notifications } = makeWorld({ users: named('Karim') as any, interventions: [job] });

    await service.notifyArtisanDeclined(100, 20, 'trop loin');

    const toClient = notifications.find((n) => n.recipientId === 10);
    const toStaff = notifications.find((n) => n.recipientId === 1);

    expect(toClient.actorId).toBeUndefined();
    expect(toClient.actor).toBeFalsy(); // the row the client reads would carry the artisan's name
    expect(toClient.data).toEqual({ interventionId: 100 });
    expect(toClient.entityType).toBe('INTERVENTION');
    expect(toClient.entityId).toBe(100);

    expect(toStaff.actorId).toBe(20);
    expect(toStaff.data).toEqual({ interventionId: 100, artisanId: 20 });
  });

  it.each(steps.map((step) => step.call))('%s: the client\'s copy still names the artisan who is coming', async (call) => {
    const { service, notifications } = makeWorld({ users: named('Karim') as any, interventions: [job] });

    await (service as any)[call](100, 20);

    expect(notifications.find((n) => n.recipientId === 10).actorId).toBe(20);
  });

  it('a back office that cannot be told does not keep the client from being told; the failure is still raised', async () => {
    const { service, notifications } = makeWorld({ users: named('Karim') as any, interventions: [job] });

    (service as any).notifyAdmins = async () => {
      throw new Error('staff list unreadable');
    };

    await expect(service.notifyArtisanDeclined(100, 20, 'trop loin')).rejects.toThrow('staff list unreadable');

    expect(recipients(notifications)).toEqual([10]);
  });

  it('a client who cannot be told does not hide that the back office was told first', async () => {
    const { service, notifications } = makeWorld({ users: named('Karim') as any, interventions: [job] });
    const notify = service.notify.bind(service);

    (service as any).notify = async (payload: any) => {
      if (payload.recipientId === 10) throw new Error('push provider down');

      return notify(payload);
    };

    await expect(service.notifyArtisanOnTheWay(100, 20)).rejects.toThrow('push provider down');

    expect(recipients(notifications)).toEqual([1, 2, 4, 5]);
  });
});

describe('proofs to look at (P1-07)', () => {
  const users = [
    { id: 1, role: 'ADMIN', isActive: true },
    { id: 2, role: 'SUPPORT', isActive: true },
    { id: 3, role: 'ACCOUNTANT', isActive: true },
    { id: 4, role: 'DISPATCHER', isActive: true },
    { id: 5, role: 'SUPER_ADMIN', isActive: true },
    { id: 10, role: 'CLIENT', isActive: true, email: 'client@example.com', name: 'Sami' },
    { id: 20, role: 'ARTISAN', isActive: true, email: 'artisan@example.com', name: 'Karim' },
  ];

  it('a photo to look at: admins, support and dispatchers, at high priority, with the reasons in words and a way to find the proof', async () => {
    const { service, notifications } = makeWorld({ users: users as any });

    await service.notifyProofNeedsReview({
      interventionId: 100,
      proofId: 31,
      kind: 'AFTER',
      artisanId: 20,
      details: ['Photo prise à 800 m de l’adresse.', 'Signal GPS peu précis (250 m).'],
    });

    expect(recipients(notifications)).toEqual([1, 2, 4, 5]);

    const first = notifications.find((n) => n.recipientId === 1);

    expect(first.type).toBe('GENERAL');
    expect(first.priority).toBe('HIGH');
    expect(first.title).toBe('Preuve à vérifier');
    expect(first.message).toBe(
      'Intervention #100: la photo après intervention est à vérifier. Photo prise à 800 m de l’adresse. Signal GPS peu précis (250 m).',
    );
    expect(first.entityType).toBe('INTERVENTION');
    expect(first.entityId).toBe(100);
    expect(first.data).toEqual({ interventionId: 100, proofId: 31 });
    expect(first.channels).toEqual(['IN_APP', 'ADMIN_REAL_TIME']);
  });

  it('the "before" photo is called that, and no reason is fine', async () => {
    const { service, notifications } = makeWorld({ users: users as any });

    await service.notifyProofNeedsReview({ interventionId: 100, proofId: 31, kind: 'BEFORE', artisanId: 20, details: [] });

    expect(notifications.find((n) => n.recipientId === 1).message).toBe('Intervention #100: la photo avant intervention est à vérifier.');
  });

  it('nobody outside the back office is told: not the customer, not the accountant', async () => {
    const { service, notifications } = makeWorld({ users: users as any });

    await service.notifyProofNeedsReview({ interventionId: 100, proofId: 31, kind: 'AFTER', artisanId: 20, details: [] });

    expect(notifications.some((n) => n.recipientId === 10 || n.recipientId === 3 || n.recipientId === 20)).toBe(false);
  });

  it('a photo refused by the back office: the artisan is told to take it again, and the reviewer is named only as the actor', async () => {
    const { service, notifications } = makeWorld({ users: users as any });

    await service.notifyProofRefused({ interventionId: 100, proofId: 31, kind: 'AFTER', artisanId: 20, actorId: 4 });
    await service.notifyProofRefused({ interventionId: 101, proofId: 32, kind: 'AFTER', artisanId: 20, actorId: 4, retake: false });

    expect(recipients(notifications)).toEqual([20, 20]);
    expect(notifications[0].message).toBe(
      'La photo après intervention de la mission #100 a été refusée par l’équipe. Reprenez-la sur place.',
    );
    // The job is closed: there is nothing to retake, the team will call.
    expect(notifications[1].message).toBe(
      'La photo après intervention de la mission #101 a été refusée par l’équipe. L’équipe vous contactera.',
    );
    expect(notifications[0].priority).toBe('HIGH');
    expect(notifications[0].data).toEqual({ interventionId: 100, proofId: 31 });
  });
});
