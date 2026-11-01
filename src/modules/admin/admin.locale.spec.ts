import { buildWorld } from '../../common/testing/world';
import { AdminService } from './admin.service';

const FSI = '⁨';
const PDI = '⁩';

/**
 * What the back office does and the customer reads (P3-04): the texts sent after a status change or a quote are written in the language
 * of the customer; the notice to the technician in theirs. The real AdminService on the in-memory database of the access suite, with a notifier that
 * writes down what it is asked to send.
 */
function makeWorld(customer: { locale?: string } = {}, technician: { locale?: string } = {}) {
  const w = buildWorld();
  const sms: Array<{ to: string; body: string }> = [];
  const emails: Array<{ to: string; subject: string; body: string }> = [];
  const notices: any[] = [];
  const notifications: any = {
    sendSms: async (to: string, body: string) => (sms.push({ to, body }), { queued: true }),
    sendEmail: async (to: string, subject: string, body: string) => (emails.push({ to, subject, body }), { queued: true }),
    notify: async (payload: any) => (notices.push(payload), {}),
    notifyQuoteSent: async () => [],
    isEmailSimulated: () => false,
  };

  const service = new AdminService(w.prisma, notifications, w.svc.events, w.svc.contactChange, w.svc.assignment, w.svc.realtime);
  const job = w.memory.rows('intervention').find((entry) => entry.id === w.ids.A.intervention) as any;
  const client = w.memory.rows('user').find((entry) => entry.id === job.clientId) as any;
  const artisan = w.memory.rows('user').find((entry) => entry.id === job.artisanId) as any;

  Object.assign(client, { phone: '22 123 456', email: 'client@example.com' }, customer);
  Object.assign(artisan, technician);

  return { w, service, sms, emails, notices, job, client, artisan, admin: w.people.admin.user as any };
}

const row = (m: ReturnType<typeof makeWorld>, status: string) => ({ ...m.job, status, clientId: m.client.id, client: { id: m.client.id, phone: m.client.phone }, artisan: { name: 'Ali' } });

describe('the texts after a status change by the back office (P3-04)', () => {
  it('the technician accepted: an Arabic customer is told in Arabic, with the technician’s name set apart; a French customer in French', async () => {
    const arabic = makeWorld({ locale: 'ar' });
    const french = makeWorld({ locale: 'fr' });

    await (arabic.service as any).tellAboutStatusChange('ASSIGNED', row(arabic, 'ARTISAN_ACCEPTED'), arabic.admin.id);
    await (french.service as any).tellAboutStatusChange('ASSIGNED', row(french, 'ARTISAN_ACCEPTED'), french.admin.id);

    expect(arabic.sms[0].body).toBe(`تم قبول طلبك! يتولّاه ${FSI}Ali${PDI}. Smart-Dépannage`);
    expect(french.sms[0].body).toBe('Smart Dépannage: Votre demande a été acceptée ! Ali prend en charge votre dossier.');
  });

  it('the job is done: Arabic, French', async () => {
    const arabic = makeWorld({ locale: 'ar' });
    const french = makeWorld({});

    await (arabic.service as any).tellAboutStatusChange('IN_PROGRESS', row(arabic, 'COMPLETED'), arabic.admin.id);
    await (french.service as any).tellAboutStatusChange('IN_PROGRESS', row(french, 'COMPLETED'), french.admin.id);

    expect(/[؀-ۿ]/.test(arabic.sms[0].body)).toBe(true);
    expect(french.sms[0].body).toBe('Intervention terminée. Merci de votre confiance !');
  });

  it('a cancellation: the technician’s notice carries both languages, French first, and the reason as typed', async () => {
    const m = makeWorld({}, { locale: 'ar' });

    await (m.service as any).tellAboutStatusChange('ASSIGNED', row(m, 'CANCELLED'), m.admin.id, { reason: 'Client injoignable' });

    expect(m.notices.length).toBe(1);
    expect(m.notices[0].title).toBe('Mission annulée');
    expect(m.notices[0].message).toBe(`La mission #${m.job.id} a été annulée: Client injoignable`);
    expect(m.notices[0].texts('ar').title).toBe('تم إلغاء المهمّة');
    expect(m.notices[0].texts('ar').message).toContain(`${FSI}Client injoignable${PDI}`);
  });
});

describe('the quote sent by the back office (P3-04)', () => {
  const quote = { title: 'Devis', items: [{ label: 'Main d’œuvre', description: 'Main d’œuvre', quantity: 1, unitPrice: 100 }], taxRate: 20 } as any;

  it('an Arabic customer gets the SMS and the e-mail in Arabic, the amount set apart and in dinars', async () => {
    const m = makeWorld({ locale: 'ar' });

    await m.service.sendQuote(m.admin.id, m.job.id, quote);

    expect(m.sms[0].body).toBe(`وصلك عرض سعر بمبلغ ${FSI}120,000${PDI} د.ت شامل للأداء. Smart-Dépannage`);
    expect(m.emails[0].subject).toBe('عرض السعر الخاص بك من Smart-Dépannage');
    expect(m.emails[0].body).toBe(`وصلك عرض سعر بمبلغ ${FSI}120,000${PDI} د.ت شامل للأداء.`);
  });

  it('a French customer gets the French texts it always was', async () => {
    const m = makeWorld({ locale: 'fr' });

    await m.service.sendQuote(m.admin.id, m.job.id, quote);

    expect(m.sms[0].body).toBe('Smart Dépannage: vous avez reçu un devis de 120,000 TND TTC.');
    expect(m.emails[0].subject).toBe('Votre devis Smart Dépannage');
    expect(m.emails[0].body).toBe('Vous avez reçu un devis de 120,000 TND TTC.');
  });
});
