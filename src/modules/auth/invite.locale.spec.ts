import { inviteArtisan } from './invite';

process.env.FRONTEND_URL = 'https://app.example.tn';

const ARABIC = /[؀-ۿ]/;

function makeWorld() {
  const emails: any[] = [];
  const texts: any[] = [];
  const prisma: any = { authToken: { updateMany: async () => ({ count: 1 }), create: async ({ data }: any) => data } };
  const notifications: any = {
    sendEmail: async (to: string, subject: string, content: string, options: any) => emails.push({ to, subject, content, options }),
    sendSms: async (to: string, content: string, options: any) => texts.push({ to, content, options }),
    isEmailSimulated: () => false,
  };

  return { deps: { prisma, notifications }, emails, texts };
}

const person = (locale?: string | null) => ({ id: 12, email: 'sami@mail.tn', name: 'Sami', phone: '+21655222333', locale });

describe('the invitation of a technician, in their language (P3-04)', () => {
  it('an accepted application, in Arabic: the mail and the text are Arabic, the link is set apart in both, the Arabic template is the one looked for', async () => {
    const w = makeWorld();

    await inviteArtisan(w.deps, person('ar'), 'approved');

    expect(w.emails[0].subject).toBe('تم قبول طلب انضمامك');
    expect(w.emails[0].content).toMatch(/^خبر سار: تم قبول طلب انضمامك كفنّي\./);
    expect(w.emails[0].content).toMatch(/ https:\/\/app\.example\.tn\/reset-password\?token=[0-9a-f]{64}$/);
    expect(w.emails[0].options.locale).toBe('ar');
    expect(w.emails[0].options.template.key).toBe('artisan.application_approved');
    expect(ARABIC.test(w.texts[0].content)).toBe(true);
    expect(w.texts[0].content).toMatch(/ https:\/\/app\.example\.tn\/reset-password\?token=[0-9a-f]{64}$/);
  });

  it('a technician added by hand, in Arabic', async () => {
    const w = makeWorld();

    await inviteArtisan(w.deps, person('ar'), 'created');

    expect(w.emails[0].subject).toBe('إنشاء كلمة المرور');
    expect(w.emails[0].options.template.key).toBe('auth.password_setup');
    expect(ARABIC.test(w.texts[0].content)).toBe(true);
  });

  it('French, or no language on the row: the French texts, word for word', async () => {
    for (const locale of ['fr', null, undefined]) {
      const w = makeWorld();

      await inviteArtisan(w.deps, person(locale), 'approved');

      expect(w.emails[0].subject).toBe('Votre candidature est acceptée');
      expect(w.emails[0].content).toMatch(/^Bonne nouvelle: votre candidature artisan est acceptée\. Choisissez votre mot de passe \(lien valable 24 heures, usage unique\) : https:/);
      expect(w.emails[0].options.locale).toBe('fr');
      expect(w.texts[0].content).toMatch(/^Smart Dépannage: votre candidature est acceptée\. Créez votre mot de passe ici: https:/);
    }
  });
});
