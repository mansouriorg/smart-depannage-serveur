import { NotificationsService } from './notifications.service';
import { MessageTemplatesService } from './delivery/message-templates.service';

const FSI = '⁨';
const PDI = '⁩';
const ARABIC = /[؀-ۿ]/;
/** What an Arabic text may keep in Latin letters: the brand, and the values (a number, an address, a name) set apart. */
const LATIN_WORD = /[A-Za-zÀ-ÿ]{2,}/;

type User = { id: number; role: string; isActive: boolean; email?: string; phone?: string; name?: string; locale?: string };

/** An in-memory stand-in for the few Prisma calls the service makes (the same idea as notifications.service.spec). */
function makeWorld(extra: Partial<{ users: User[]; templates: Record<string, any>; interventions: any[]; quotes: any[]; payments: any[]; invoices: any[]; messages: any[]; complaints: any[] }> = {}) {
  const users: User[] = extra.users ?? [
    { id: 1, role: 'ADMIN', isActive: true, locale: 'ar' },
    { id: 2, role: 'SUPPORT', isActive: true, locale: 'ar' },
    { id: 4, role: 'DISPATCHER', isActive: true, locale: 'ar' },
    { id: 5, role: 'SUPER_ADMIN', isActive: true },
    { id: 10, role: 'CLIENT', isActive: true, email: 'client@example.com', phone: '+21620111222', name: 'Sami', locale: 'ar' },
    { id: 11, role: 'CLIENT', isActive: true, email: 'french@example.com', phone: '+21620111333', name: 'Karim', locale: 'fr' },
    { id: 12, role: 'CLIENT', isActive: true, email: 'old@example.com', phone: '+21620111444', name: 'Salma' },
    { id: 13, role: 'CLIENT', isActive: true, email: 'guest_13@guest.smart-depannage.local', phone: '+21620111555', name: 'Hela', locale: 'ar' },
    { id: 14, role: 'CLIENT', isActive: true, email: 'guest_14@guest.smart-depannage.local', phone: '+21620111666', name: 'Hedi', locale: 'fr' },
    { id: 20, role: 'ARTISAN', isActive: true, email: 'artisan@example.com', phone: '+21620999000', name: 'Ali', locale: 'ar' },
    { id: 21, role: 'ARTISAN', isActive: true, email: 'artisan2@example.com', phone: '+21620999111', name: 'Omar', locale: 'fr' },
  ];

  const notifications: any[] = [];
  const queued: any[] = [];
  let nextId = 1;
  const byId = (list: any[], id: number) => list.find((row) => row.id === id) ?? null;
  // The database gives back only the columns that `select` names: a query that forgets the language must show here as it would there.
  const selected = (row: any, select?: Record<string, unknown>) =>
    !row || !select ? row : Object.fromEntries(Object.entries(select).filter(([, wanted]) => wanted).map(([name]) => [name, row[name]]));

  const prisma: any = {
    user: {
      findUnique: async ({ where, select }: any) => selected(byId(users, where.id), select),
      findMany: async ({ where, select }: any) =>
        users
          .filter((u) => (where.isActive === undefined || u.isActive === where.isActive) && (!where.role?.in || where.role.in.includes(u.role)))
          .map((u) => selected(u, select)),
    },
    notificationPreference: { upsert: async ({ create }: any) => ({ ...create }) },
    notification: {
      create: async ({ data }: any) => {
        const row = { id: nextId++, isRead: false, readAt: null, deletedAt: null, ...data, recipient: byId(users, data.recipientId), actor: null, deliveries: [] };
        notifications.push(row);
        return row;
      },
    },
    notificationDeliveryLog: { create: async ({ data }: any) => ({ id: 1, ...data }), update: async () => ({}) },
    notificationTemplate: { findUnique: async ({ where }: any) => extra.templates?.[where.key] ?? null },
    quote: { findUnique: async ({ where }: any) => byId(extra.quotes ?? [], where.id) },
    intervention: { findUnique: async ({ where }: any) => byId(extra.interventions ?? [], where.id) },
    payment: { findUnique: async ({ where }: any) => byId(extra.payments ?? [], where.id) },
    invoice: { findUnique: async ({ where }: any) => byId(extra.invoices ?? [], where.id) },
    message: { findUnique: async ({ where }: any) => byId(extra.messages ?? [], where.id) },
    complaint: { findUnique: async ({ where }: any) => byId(extra.complaints ?? [], where.id) },
    pushDeviceToken: { findMany: async () => [] },
  };

  const outbox: any = {
    enqueue: async (input: any) => {
      queued.push(input);
      return { id: queued.length };
    },
    isEmailConfigured: () => false,
    isSmsConfigured: () => false,
    isPushConfigured: () => false,
    providerName: () => 'FAKE',
  };

  const service = new NotificationsService(prisma, { emitToUser: () => undefined } as any, outbox, new MessageTemplatesService(prisma));
  (service as any).logger = { log: () => undefined, warn: () => undefined, error: () => undefined };

  return { service, notifications, queued, users };
}

const toUser = (notifications: any[], id: number) => notifications.find((n) => n.recipientId === id);

const intervention = { id: 100, clientId: 10, artisanId: 20, address: '12 rue de Marseille, Tunis', serviceType: 'PLUMBING', client: {}, artisan: {} };
const quote = { id: 7, interventionId: 100, amountTTC: 120, intervention };

describe('a customer is written to in their own language (P3-04)', () => {
  it('a quote sent to a customer who chose Arabic: the title and the text are Arabic, the amount set apart and in dinars', async () => {
    const { service, notifications } = makeWorld({ quotes: [{ ...quote, intervention: { ...intervention, clientId: 10 } }] });

    await service.notifyQuoteSent(7, 1);

    expect(notifications.length).toBe(1);
    expect(notifications[0].title).toBe('وصلك عرض سعر');
    expect(notifications[0].message).toBe(`تم إرسال عرض سعر إليك بمبلغ ${FSI}120,000${PDI} د.ت شامل للأداء.`);
  });

  it('the same quote for a customer who chose French is the French text it always was', async () => {
    const { service, notifications } = makeWorld({ quotes: [{ ...quote, intervention: { ...intervention, clientId: 11 } }] });

    await service.notifyQuoteSent(7, 1);

    expect(notifications[0].title).toBe('Devis reçu');
    expect(notifications[0].message).toBe('Un devis de 120,000 TND TTC vous a été envoyé.');
  });

  it('a customer who never chose (a row with no language) is written to in French', async () => {
    const { service, notifications } = makeWorld({ quotes: [{ ...quote, intervention: { ...intervention, clientId: 12 } }] });

    await service.notifyQuoteSent(7, 1);

    expect(notifications[0].title).toBe('Devis reçu');
  });

  it('a payment confirmed, an invoice ready, a refund: the customer reads Arabic or French as they chose', async () => {
    const world = makeWorld({
      payments: [{ id: 9, interventionId: 100, amount: 50, currency: 'TND', intervention }],
      invoices: [{ id: 3, interventionId: 100, invoiceNumber: 'FAC-2026-0007', intervention }],
    });

    await world.service.notifyPaymentReceived(9, 1);
    await world.service.notifyInvoiceReady(3, 1);

    const mine = world.notifications.filter((n) => n.recipientId === 10);

    expect(mine.length).toBe(2);
    expect(mine[0].title).toBe('تم تأكيد الدفع');
    expect(mine[0].message).toBe(`تم تأكيد دفعتك بمبلغ ${FSI}50,000${PDI} د.ت.`);
    expect(mine[1].title).toBe('الفاتورة متاحة');
    expect(mine[1].message).toBe(`فاتورتك ${FSI}FAC-2026-0007${PDI} متاحة.`);
  });

  it('a technician who chose Arabic gets the assignment in Arabic, with the address and the visit set apart; one who chose French gets French', async () => {
    const world = makeWorld({ interventions: [intervention, { ...intervention, id: 101, artisanId: 21, clientId: 11 }] });

    await world.service.notifyArtisanAssigned(100, 20, 1, { when: '19/10/2026 à 08:00' });
    await world.service.notifyArtisanAssigned(101, 21, 1, { when: '19/10/2026 à 08:00' });

    const arabic = toUser(world.notifications, 20);
    const french = toUser(world.notifications, 21);

    expect(arabic.title).toBe('تم تعيين مهمّة جديدة لك');
    expect(arabic.message).toBe(`تم تعيين مهمّة لك: ${FSI}12 rue de Marseille, Tunis${PDI}. الموعد: ${FSI}19/10/2026${PDI} الساعة ${FSI}08:00${PDI}.`);
    expect(french.title).toBe('Nouvelle mission assignée');
    expect(french.message).toBe('Une mission vous a été assignée: 12 rue de Marseille, Tunis. Rendez-vous le 19/10/2026 à 08:00.');
  });

  it('the customer of that job is told in their own language, not the technician’s', async () => {
    const world = makeWorld({ interventions: [{ ...intervention, clientId: 11, artisanId: 20 }] });

    await world.service.notifyArtisanAssigned(100, 20, 1);

    expect(toUser(world.notifications, 11).title).toBe('Artisan assigné');
    expect(toUser(world.notifications, 20).title).toBe('تم تعيين مهمّة جديدة لك');
  });

  it('the steps of a mission tell the customer in their language, with the technician’s name set apart', async () => {
    const world = makeWorld({ interventions: [{ ...intervention, clientId: 10 }, { ...intervention, id: 101, clientId: 11 }] });

    await world.service.notifyArtisanOnTheWay(100, 20);
    await world.service.notifyArtisanOnTheWay(101, 21);

    const ar = world.notifications.find((n) => n.recipientId === 10);
    const fr = world.notifications.find((n) => n.recipientId === 11);

    expect(ar.title).toBe('الفنّي في الطريق');
    expect(ar.message).toContain(`${FSI}Ali${PDI}`);
    expect(fr.title).toBe('Artisan en route');
    expect(fr.message).toBe('Votre artisan Omar est en route.');
  });

  it('every customer text is Arabic letters with no stray French word', async () => {
    const world = makeWorld({
      interventions: [intervention],
      quotes: [quote],
      payments: [{ id: 9, interventionId: 100, amount: 50, currency: 'TND', intervention }],
      invoices: [{ id: 3, interventionId: 100, invoiceNumber: 'FAC-1', intervention }],
    });

    await world.service.notifyQuoteSent(7, 1);
    await world.service.notifyPaymentReceived(9, 1);
    await world.service.notifyInvoiceReady(3, 1);
    await world.service.notifyArtisanAssigned(100, 20, 1);
    await world.service.notifyArtisanAcceptedMission(100, 20);
    await world.service.notifyArtisanOnTheWay(100, 20);
    await world.service.notifyArtisanArrived(100, 20);
    await world.service.notifyArtisanDeclined(100, 20, 'Trop loin');

    const toCustomer = world.notifications.filter((n) => n.recipientId === 10);

    expect(toCustomer.length).toBeGreaterThanOrEqual(8);

    for (const row of toCustomer) {
      const words = `${row.title} ${row.message}`.replace(new RegExp(`${FSI}[^${PDI}]*${PDI}`, 'g'), '');

      expect(`${row.type}: ${ARABIC.test(row.title) && ARABIC.test(row.message)}`).toBe(`${row.type}: true`);
      expect(`${row.type}: ${LATIN_WORD.test(words)} ${words}`).toBe(`${row.type}: false ${words}`);
    }
  });

  it('a notification keeps the language it was written in when the person later changes theirs', async () => {
    const world = makeWorld({ quotes: [quote] });

    await world.service.notifyQuoteSent(7, 1);

    world.users.find((u) => u.id === 10)!.locale = 'fr';

    expect(world.notifications[0].title).toBe('وصلك عرض سعر');

    await world.service.notifyQuoteSent(7, 1);

    expect(world.notifications[1].title).toBe('Devis reçu');
  });
});

describe('the back office is always written to in French (P3-04)', () => {
  it('a notice meant for a customer and also given to staff reads French for the staff, even for a dispatcher who stored Arabic', async () => {
    const world = makeWorld({ quotes: [quote] });

    await world.service.notifyQuoteAccepted(7, 10);

    // the dispatcher (4, locale ar), the support (2, locale ar), the admin (1, locale ar) and the super admin: French, all four
    for (const id of [1, 2, 4, 5]) {
      expect(`${id}: ${toUser(world.notifications, id).title}`).toBe(`${id}: Devis accepté`);
      expect(`${id}: ${toUser(world.notifications, id).message}`).toBe(`${id}: Le client a accepté le devis #7.`);
    }

    // the technician of the job, who chose Arabic, gets the Arabic of the same notice
    expect(toUser(world.notifications, 20).title).toBe('تم قبول عرض السعر');
    expect(toUser(world.notifications, 20).message).toContain(`${FSI}#7${PDI}`);
  });

  it('notifyAdmins with texts for both languages still writes French to every staff account', async () => {
    const world = makeWorld({ quotes: [quote] });

    const created = await world.service.notifyAdmins({
      type: 'GENERAL' as any,
      title: 'Titre',
      message: 'Texte',
      texts: () => ({ title: 'عنوان', message: 'نص' }),
    } as any);

    expect(created.length).toBe(4);
    expect(created.map((n: any) => n.title)).toEqual(['Titre', 'Titre', 'Titre', 'Titre']);
  });

  it('the staff notices that are only French (a new request, a problem, an application) are untouched', async () => {
    const world = makeWorld({ interventions: [intervention] });

    await world.service.notifyNewInterventionCreated(100, 10);

    expect(world.notifications.length).toBeGreaterThan(0);

    for (const row of world.notifications) {
      expect(row.title).toBe('Nouvelle intervention créée');
      expect(row.message).toBe('Nouvelle demande PLUMBING à 12 rue de Marseille, Tunis.');
    }
  });

  it('the chat: the customer reads Arabic when support writes, the support team reads French when the customer writes', async () => {
    const world = makeWorld({
      users: [
        { id: 2, role: 'SUPPORT', isActive: true, locale: 'ar', name: 'Leila' },
        { id: 10, role: 'CLIENT', isActive: true, email: 'client@example.com', name: 'Sami', locale: 'ar' },
        { id: 20, role: 'ARTISAN', isActive: true, email: 'artisan@example.com', name: 'Ali', locale: 'ar' },
      ],
      messages: [
        { id: 5, interventionId: 100, senderId: 2, audience: 'CLIENT_SUPPORT', content: 'Bonjour', deletedAt: null, sender: { id: 2, name: 'Leila', role: 'SUPPORT' }, intervention: { id: 100, clientId: 10, artisanId: 20 } },
        { id: 6, interventionId: 100, senderId: 10, audience: 'CLIENT_SUPPORT', content: '', deletedAt: null, sender: { id: 10, name: 'Sami', role: 'CLIENT' }, intervention: { id: 100, clientId: 10, artisanId: 20 } },
      ],
    });

    await world.service.notifyNewMessage(5);
    await world.service.notifyNewMessage(6);

    const toCustomer = toUser(world.notifications, 10);
    const toSupport = toUser(world.notifications, 2);

    expect(toCustomer.title).toBe(`رسالة جديدة (الطلب ${FSI}#100${PDI})`);
    expect(toCustomer.message).toBe(`${FSI}Leila${PDI}: ${FSI}Bonjour${PDI}`);
    expect(toSupport.title).toBe('Nouveau message (demande #100)');
    expect(toSupport.message).toBe('Sami: Pièce jointe');
  });
});

describe('a guest who has no mailbox is texted instead, in their language (P3-04)', () => {
  it('the e-mail of a notice cannot go to a made-up address: the text goes to the phone in Arabic or French, with the Arabic row of the template when there is one', async () => {
    const templates = {
      'QUOTE_SENT.SMS': { type: 'SMS', isActive: true, content: 'Devis: {{message}}' },
      'QUOTE_SENT.SMS@ar': { type: 'SMS', isActive: true, content: 'عرض: {{message}}' },
    };
    const world = makeWorld({
      templates,
      quotes: [
        { ...quote, intervention: { ...intervention, clientId: 13 } },
        { ...quote, id: 8, intervention: { ...intervention, clientId: 14 } },
      ],
    });

    await world.service.notifyQuoteSent(7, 1, ['EMAIL'] as any);
    await world.service.notifyQuoteSent(8, 1, ['EMAIL'] as any);

    expect(world.queued.length).toBe(2);
    expect(world.queued[0].body).toBe(`عرض: تم إرسال عرض سعر إليك بمبلغ ${FSI}120,000${PDI} د.ت شامل للأداء.`);
    expect(world.queued[1].body).toBe('Devis: Un devis de 120,000 TND TTC vous a été envoyé.');
  });
});

describe('a person who is only a destination (P3-04)', () => {
  it('sendSms and sendEmail send what the caller wrote, in the language the caller chose', async () => {
    const { service, queued } = makeWorld();

    await service.sendSms('+21620000000', 'نص عربي', { locale: 'ar' });
    await service.sendEmail('a@example.com', 'الموضوع', 'نص', { locale: 'ar' });

    expect(queued.map((q) => q.body)).toEqual(['نص عربي', 'نص']);
    expect(queued[1].subject).toBe('الموضوع');
  });

  it('an Arabic message looks for the Arabic template, a French one for the French template', async () => {
    const templates = {
      'guest.tracking_sms': { type: 'SMS', isActive: true, content: 'FR {{link}}' },
      'guest.tracking_sms@ar': { type: 'SMS', isActive: true, content: 'AR {{link}}' },
    };
    const { service, queued } = makeWorld({ templates });

    const options = (locale: 'fr' | 'ar') => ({ locale, template: { key: 'guest.tracking_sms', vars: { link: 'L' } } });

    await service.sendSms('+21620000000', 'built-in', options('ar'));
    await service.sendSms('+21620000000', 'built-in', options('fr'));
    await service.sendSms('+21620000000', 'built-in', { template: { key: 'guest.tracking_sms', vars: { link: 'L' } } });

    expect(queued.map((q) => q.body)).toEqual(['AR L', 'FR L', 'FR L']);
  });

  it('an Arabic message with only a French template sends the built-in Arabic text, never the French template', async () => {
    const templates = { 'guest.tracking_sms': { type: 'SMS', isActive: true, content: 'FR {{link}}' } };
    const { service, queued } = makeWorld({ templates });

    await service.sendSms('+21620000000', 'نص عربي مدمج', { locale: 'ar', template: { key: 'guest.tracking_sms', vars: { link: 'L' } } });

    expect(queued[0].body).toBe('نص عربي مدمج');
  });

  it('a notification for a customer who chose Arabic uses the Arabic row of the type and channel, not the French one', async () => {
    const templates = {
      'QUOTE_SENT.SMS': { type: 'SMS', isActive: true, content: 'Devis: {{message}}' },
      'QUOTE_SENT.SMS@ar': { type: 'SMS', isActive: true, content: 'عرض: {{message}}' },
    };
    const world = makeWorld({ templates, quotes: [{ ...quote, intervention: { ...intervention, clientId: 10 } }, { ...quote, id: 8, intervention: { ...intervention, clientId: 11 } }] });

    await world.service.notifyQuoteSent(7, 1, ['SMS'] as any);
    await world.service.notifyQuoteSent(8, 1, ['SMS'] as any);

    expect(world.queued.length).toBe(2);
    expect(world.queued[0].body.startsWith('عرض: ')).toBe(true);
    expect(world.queued[1].body.startsWith('Devis: ')).toBe(true);
  });
});
