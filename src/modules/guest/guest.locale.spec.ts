import { fakeSubServices } from '../../common/testing/catalog';
import { FakeTable, withTransactions } from '../../common/testing/fake-tables';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { GuestService } from './guest.service';

process.env.FRONTEND_URL = 'https://www.example.tn';

const FSI = '⁨';
const PDI = '⁩';
const ARABIC = /[؀-ۿ]/;

type SendOptions = { userId?: number; locale?: string; validForMs?: number; template?: { key: string; vars?: any } };

/**
 * A visitor’s language (P3-04): the guest profile keeps the language the website showed (header X-App-Locale), and the tracking link,
 * the activation code and the activation link are written in it. No header changes nothing.
 */
function makeWorld() {
  const users = new FakeTable({
    unique: ['email', 'phoneKey'],
    honourSelect: true,
    defaults: () => ({
      name: 'Client invité',
      role: 'CLIENT',
      isActive: true,
      isGuest: false,
      deletedAt: null,
      phone: null,
      phoneKey: null,
      emailVerifiedAt: null,
      phoneVerifiedAt: null,
      locale: 'fr',
    }),
  });
  const interventions = new FakeTable({ defaults: () => ({ status: 'PENDING', photos: [], adminInternalNotes: null }) });

  const intervention = {
    ...interventions,
    findFirst: interventions.findFirst,
    create: async ({ data }: any) => {
      const row = interventions.insert(data);
      const owner = users.rows.find((user) => user.id === row.clientId)!;

      return { ...row, client: { id: owner.id, name: owner.name, phone: owner.phone, email: owner.email, isGuest: owner.isGuest }, subService: null };
    },
  };

  const authToken = new FakeTable({ unique: ['tokenHash'], defaults: () => ({ usedAt: null, revokedAt: null, newValue: null }) });

  // The users table gives back only the columns that `select` names, as the database does: a service that forgets a column in its
  // `select` must show here as it would with the real database.
  const prisma: any = withTransactions({ user: users, intervention, authToken, subService: fakeSubServices() }, [users, interventions, authToken]);

  const sentSms: Array<{ to: string; body: string; options?: SendOptions }> = [];
  const sentEmails: Array<{ to: string; subject: string; body: string; options?: SendOptions }> = [];
  const notifications: any = {
    sendSms: async (to: string, body: string, options?: SendOptions) => (sentSms.push({ to, body, options }), { queued: true }),
    sendEmail: async (to: string, subject: string, body: string, options?: SendOptions) => (sentEmails.push({ to, subject, body, options }), { queued: true }),
  };

  const staffAlerts: any = { newRequest: async () => undefined, problemReported: async () => undefined };
  const service = new GuestService(prisma, notifications, { create: async () => undefined } as any, new RateLimitService(), staffAlerts, {} as any, {} as any);

  return { service, users, sentSms, sentEmails };
}

let phoneCounter = 0;
const nextPhone = () => `2${String(1000000 + ++phoneCounter).slice(1)}`.padEnd(8, '0').slice(0, 8);

const form = (extra: Record<string, unknown> = {}) =>
  ({ serviceType: 'PLOMBIER', description: 'Fuite sous évier', address: 'Rue de Marseille, Tunis', contactName: 'Sami', contactPhone: nextPhone(), ...extra }) as any;

describe('the guest profile keeps the language of the visit (P3-04)', () => {
  it('a visitor whose page is in Arabic gets a profile in Arabic', async () => {
    const w = makeWorld();

    await w.service.createGuestIntervention(form(), 'ar');

    expect(w.users.rows.length).toBe(1);
    expect(w.users.rows[0].locale).toBe('ar');
  });

  it('a visitor whose page is in French gets a profile in French', async () => {
    const w = makeWorld();

    await w.service.createGuestIntervention(form(), 'fr');

    expect(w.users.rows[0].locale).toBe('fr');
  });

  it('a request without the header starts a profile in French', async () => {
    const w = makeWorld();

    await w.service.createGuestIntervention(form(), null);
    await w.service.createGuestIntervention(form());

    expect(w.users.rows.map((row) => row.locale)).toEqual(['fr', 'fr']);
  });

  it('a returning visitor who now asks in another language is updated, and written to in it from then on', async () => {
    const w = makeWorld();
    const phone = nextPhone();

    await w.service.createGuestIntervention(form({ contactPhone: phone }), 'fr');
    expect(w.users.rows[0].locale).toBe('fr');

    await w.service.createGuestIntervention(form({ contactPhone: phone }), 'ar');

    expect(w.users.rows.length).toBe(1);
    expect(w.users.rows[0].locale).toBe('ar');
    expect(ARABIC.test(w.sentSms[w.sentSms.length - 1].body)).toBe(true);
  });

  it('a returning visitor whose request does not say a language keeps the one they had', async () => {
    const w = makeWorld();
    const phone = nextPhone();

    await w.service.createGuestIntervention(form({ contactPhone: phone }), 'ar');
    await w.service.createGuestIntervention(form({ contactPhone: phone }), null);
    await w.service.createGuestIntervention(form({ contactPhone: phone }));

    expect(w.users.rows.length).toBe(1);
    expect(w.users.rows[0].locale).toBe('ar');
    expect(w.sentSms.every((sms) => ARABIC.test(sms.body))).toBe(true);
  });
});

describe('the tracking link is written in the language of the visit (P3-04)', () => {
  it('Arabic: the SMS and the e-mail are Arabic, the request number and the link set apart, and the Arabic template row is the one looked for', async () => {
    const w = makeWorld();

    const answer = await w.service.createGuestIntervention(form({ contactEmail: 'sami@example.tn', contactName: 'Sami' }), 'ar');
    const id = (answer.intervention as any).id;

    expect(w.sentSms.length).toBe(1);
    expect(w.sentSms[0].body).toBe(`تم تسجيل طلبك ${FSI}#${id}${PDI} في Smart-Dépannage. تتبّعه من هنا: ${answer.trackingUrl}`);
    expect(w.sentSms[0].options?.locale).toBe('ar');
    expect(w.sentSms[0].options?.template?.key).toBe('guest.tracking_sms');

    expect(w.sentEmails.length).toBe(1);
    expect(w.sentEmails[0].subject).toBe('طلبك في Smart-Dépannage');
    expect(w.sentEmails[0].body).toContain(`${FSI}Sami${PDI}`);
    expect(w.sentEmails[0].body).toContain(`رقم ${FSI}${id}${PDI}`);
    expect(w.sentEmails[0].body).toContain(`:\n${answer.trackingUrl}\n`);
    expect(w.sentEmails[0].body).not.toContain(`${FSI}${answer.trackingUrl}`);
    expect(w.sentEmails[0].body).not.toContain(`${answer.trackingUrl}${PDI}`);
    expect(w.sentEmails[0].options?.locale).toBe('ar');
  });

  it('French: exactly the SMS and the e-mail the website always got', async () => {
    const w = makeWorld();

    const answer = await w.service.createGuestIntervention(form({ contactEmail: 'sami@example.tn' }), 'fr');
    const id = (answer.intervention as any).id;

    expect(w.sentSms[0].body).toBe(`Smart Dépannage: votre demande #${id} est enregistrée. Suivez-la ici: ${answer.trackingUrl}`);
    expect(w.sentEmails[0].subject).toBe('Votre demande Smart Dépannage');
    expect(w.sentEmails[0].body).toBe(
      `Bonjour Sami,\n\nVotre demande n°${id} est enregistrée. Suivez son avancement avec ce lien personnel (ne le partagez pas) :\n${answer.trackingUrl}\n\nL'équipe Smart Dépannage`,
    );
    expect(w.sentSms[0].options?.locale).toBe('fr');
  });

  it('no header: French, as before', async () => {
    const w = makeWorld();

    await w.service.createGuestIntervention(form());

    expect(w.sentSms[0].body.startsWith('Smart Dépannage: votre demande')).toBe(true);
  });
});

describe('asking for the activation of a profile (P3-04)', () => {
  async function guestWith(w: ReturnType<typeof makeWorld>, language: 'fr' | 'ar' | null) {
    const phone = nextPhone();

    await w.service.createGuestIntervention(form({ contactPhone: phone, contactEmail: `v${phone}@example.tn` }), language);
    w.sentSms.length = 0;
    w.sentEmails.length = 0;

    return { phone, email: `v${phone}@example.tn` };
  }

  it('the page in Arabic: the code and the link are Arabic, and the profile is not changed by a request that proves nothing', async () => {
    const w = makeWorld();
    const { phone, email } = await guestWith(w, 'fr');

    await w.service.requestAccountActivation({ email, phone } as any, 'client-ar', 'ar');

    expect(w.users.rows[0].locale).toBe('fr');
    expect(w.sentEmails[0].subject).toBe('تفعيل حسابك');
    expect(w.sentEmails[0].options?.locale).toBe('ar');
    expect(w.sentSms[0].body).toMatch(/^رمز تفعيل حسابك في Smart-Dépannage هو \d{6}\. صالح لمدة 10 دقائق\.$/);
    expect(w.sentSms[0].options?.locale).toBe('ar');
    expect(w.sentSms[0].options?.template?.key).toBe('guest.activation_sms');
  });

  it('the page in French: the French code and link', async () => {
    const w = makeWorld();
    const { phone, email } = await guestWith(w, 'ar');

    await w.service.requestAccountActivation({ email, phone } as any, 'client-fr', 'fr');

    expect(w.users.rows[0].locale).toBe('ar');
    expect(w.sentEmails[0].subject).toBe('Activation de votre compte');
    expect(w.sentSms[0].body).toMatch(/^Smart Dépannage: votre code d’activation est \d{6}\. Il est valable 10 minutes\.$/);
  });

  it('without the header the profile’s own language is used and nothing is changed', async () => {
    const w = makeWorld();
    const { phone, email } = await guestWith(w, 'ar');

    await w.service.requestAccountActivation({ email, phone } as any, 'client-none');

    expect(w.users.rows[0].locale).toBe('ar');
    expect(w.sentEmails[0].subject).toBe('تفعيل حسابك');
    expect(ARABIC.test(w.sentSms[0].body)).toBe(true);
  });

  it('the language of the page does not stay: the next code, asked without a page, is in the language of the profile', async () => {
    const w = makeWorld();
    const { phone, email } = await guestWith(w, 'fr');

    await w.service.requestAccountActivation({ email, phone } as any, 'client-a', 'ar');
    await w.service.requestAccountActivation({ email, phone } as any, 'client-b');

    expect(ARABIC.test(w.sentSms[0].body)).toBe(true);
    expect(w.sentSms[1].body).toMatch(/^Smart Dépannage: votre code d’activation est/);
    expect(w.sentEmails[1].subject).toBe('Activation de votre compte');
  });

  it('after the code, the link that proves the address is in the language of the profile, which the activation select must return', async () => {
    const w = makeWorld();
    const { phone, email } = await guestWith(w, 'ar');

    await w.service.requestAccountActivation({ email, phone } as any, 'client-c');
    const code = w.sentSms[0].body.match(/(\d{6})/)![1];
    w.sentEmails.length = 0;

    await w.service.activateGuestAccount({ phone, otp: code, password: 'Secret123', email } as any);

    expect(w.sentEmails.length).toBe(1);
    expect(w.sentEmails[0].options?.locale).toBe('ar');
    expect(ARABIC.test(w.sentEmails[0].subject)).toBe(true);
  });

  it('a profile that never had a language is written to in French', async () => {
    const w = makeWorld();
    const { phone, email } = await guestWith(w, null);

    await w.service.requestAccountActivation({ email, phone } as any, 'client-old');

    expect(w.users.rows[0].locale).toBe('fr');
    expect(w.sentEmails[0].subject).toBe('Activation de votre compte');
  });
});
