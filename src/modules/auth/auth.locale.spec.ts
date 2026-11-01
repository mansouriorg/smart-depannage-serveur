import * as argon2 from 'argon2';

import { MemoryPrisma } from '../../common/testing/memory-prisma';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { ContactChangeService } from '../users/contact-change.service';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';

process.env.FRONTEND_URL = 'https://app.example.tn';
process.env.JWT_ACCESS_SECRET = 'a'.repeat(40);
process.env.JWT_REFRESH_SECRET = 'b'.repeat(40);

const FSI = '⁨';
const PDI = '⁩';
const ARABIC = /[؀-ۿ]/;

/**
 * The mails and texts of the sign-in routes are written in the language of the account (P3-04): a customer or a technician who chose
 * Arabic reads Arabic, everybody else French, the back office always French. What is sent is written down, with the options the
 * notification service receives (the language, and the key of the editable template).
 */
type Sent = { kind: 'email' | 'sms'; to: string; subject?: string; body: string; options?: any };

function fakeJwt() {
  let counter = 0;

  return {
    signAsync: async (payload: any, options: { secret: string }) => `${options.secret}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${++counter}`,
    verifyAsync: async (token: string, options: { secret: string }) => {
      const [secret, body] = String(token).split('.');

      if (secret !== options.secret || !body) throw new Error('invalid signature');

      return JSON.parse(Buffer.from(body, 'base64url').toString());
    },
  };
}

async function makeWorld() {
  const memory = new MemoryPrisma();
  const prisma: any = memory.client();
  const hash = await argon2.hash('AliceSecret123');

  const person = (email: string, role: string, locale: string | null, extra: Record<string, unknown> = {}) =>
    memory.plant('user', { email, password: hash, name: email.split('@')[0], role, isActive: true, isGuest: false, ...(locale ? { locale } : {}), ...extra });

  const sent: Sent[] = [];
  const notifications: any = {
    sendEmail: async (to: string, subject: string, body: string, options?: any) => (sent.push({ kind: 'email', to, subject, body, options }), { queued: true }),
    sendSms: async (to: string, body: string, options?: any) => (sent.push({ kind: 'sms', to, body, options }), { queued: true }),
    isEmailSimulated: () => false,
    isSmsSimulated: () => false,
  };

  const rateLimit = new RateLimitService();
  const contactChange = new ContactChangeService(prisma, notifications, rateLimit);
  const users = new UsersService(prisma, notifications, contactChange);
  const auth = new AuthService(users, fakeJwt() as any, prisma, notifications, rateLimit);

  const arabicClient = person('sami@mail.tn', 'CLIENT', 'ar', { phone: '22 123 456', phoneKey: '+21622123456' });
  const frenchClient = person('karim@mail.tn', 'CLIENT', 'fr', { phone: '98 765 432', phoneKey: '+21698765432' });
  const oldClient = person('salma@mail.tn', 'CLIENT', null, { phone: '55 111 222', phoneKey: '+21655111222' });
  const arabicArtisan = person('ali@mail.tn', 'ARTISAN', 'ar', { phone: '99 111 222', phoneKey: '+21699111222' });
  const arabicAdmin = person('chef@mail.tn', 'ADMIN', 'ar', { phone: '97 111 222', phoneKey: '+21697111222' });

  return { memory, users, auth, sent, arabicClient, frenchClient, oldClient, arabicArtisan, arabicAdmin };
}

/** The address in a body: bare, up to the end of the line (a mark of direction against it could end up in what a phone opens). */
const link = (body: string) => /(https:\/\/\S+)/.exec(body)?.[1] ?? '';

describe('password reset', () => {
  it('a customer who chose Arabic gets the Arabic mail, the link set apart, and the Arabic template is the one looked for', async () => {
    const w = await makeWorld();

    await w.auth.forgotPassword('sami@mail.tn');

    expect(w.sent.length).toBe(1);
    expect(w.sent[0].subject).toBe('إعادة تعيين كلمة المرور');
    expect(w.sent[0].body).toMatch(/^اضغط على هذا الرابط لإعادة تعيين كلمة المرور: https:\/\/app\.example\.tn\S+$/);
    expect(w.sent[0].options.locale).toBe('ar');
    expect(w.sent[0].options.template.key).toBe('auth.password_reset');
  });

  it('a customer who chose French, or never chose, gets the French mail it always was', async () => {
    const w = await makeWorld();

    await w.auth.forgotPassword('karim@mail.tn');
    await w.auth.forgotPassword('salma@mail.tn');

    for (const mail of w.sent) {
      expect(mail.subject).toBe('Réinitialisation de votre mot de passe');
      expect(mail.body).toMatch(/^Cliquez sur ce lien pour réinitialiser votre mot de passe: https:\/\/app\.example\.tn\S+$/);
      expect(mail.options.locale).toBe('fr');
    }

    expect(w.sent.length).toBe(2);
  });

  it('a technician who chose Arabic gets Arabic; the back office gets French even with Arabic stored', async () => {
    const w = await makeWorld();

    await w.auth.forgotPassword('ali@mail.tn');
    await w.auth.forgotPassword('chef@mail.tn');

    expect(w.sent[0].subject).toBe('إعادة تعيين كلمة المرور');
    expect(w.sent[1].subject).toBe('Réinitialisation de votre mot de passe');
    expect(w.sent[1].options.locale).toBe('fr');
  });
});

describe('the password setup mail that the back office triggers', () => {
  it('a technician who chose Arabic gets it in Arabic with the Arabic template looked for; the back office, French', async () => {
    const w = await makeWorld();

    await w.auth.sendPasswordSetupEmail(w.arabicArtisan.id as number);
    await w.auth.sendPasswordSetupEmail(w.arabicAdmin.id as number);
    await w.auth.sendPasswordSetupEmail(w.frenchClient.id as number);

    expect(w.sent[0].subject).toBe('إنشاء كلمة المرور');
    expect(w.sent[0].body).toMatch(/^تم إنشاء حسابك\. اضغط هنا لإنشاء كلمة المرور: https:\/\/app\.example\.tn\/reset-password\?token=\S+$/);
    expect(w.sent[0].options.locale).toBe('ar');
    expect(w.sent[0].options.template.key).toBe('auth.password_setup');
    expect(w.sent[1].subject).toBe('Création de votre mot de passe');
    expect(w.sent[1].options.locale).toBe('fr');
    expect(w.sent[2].options.locale).toBe('fr');
  });
});

describe('verification of the e-mail address and of the phone', () => {
  it('the e-mail: Arabic for an Arabic account, French for a French one', async () => {
    const w = await makeWorld();

    await w.auth.sendEmailVerification(w.arabicClient.id as number);
    await w.auth.sendEmailVerification(w.frenchClient.id as number);

    expect(w.sent[0].subject).toBe('التحقّق من بريدك الإلكتروني');
    expect(w.sent[0].body).toMatch(/^اضغط على هذا الرابط للتحقّق من بريدك الإلكتروني: https:\/\/app\.example\.tn\/verify-email\?token=[0-9a-f]+$/);
    expect(w.sent[1].subject).toBe('Vérification de votre email');
    expect(w.sent[1].body).toMatch(/^Cliquez sur ce lien pour vérifier votre email: https:/);
    // the language goes to the notification service with the mail: an edited template is looked for in it
    expect(w.sent[0].options.locale).toBe('ar');
    expect(w.sent[0].options.template.key).toBe('auth.email_verification');
    expect(w.sent[1].options.locale).toBe('fr');
  });

  it('the code by SMS: Arabic for an Arabic account (the code is plain digits, not set apart), French otherwise', async () => {
    const w = await makeWorld();

    await w.auth.sendPhoneVerification(w.arabicClient.id as number);
    await w.auth.sendPhoneVerification(w.oldClient.id as number);

    expect(w.sent[0].body).toMatch(/^رمز التحقّق الخاص بك هو: \d{6}$/);
    expect(w.sent[0].options.locale).toBe('ar');
    expect(w.sent[0].options.template.key).toBe('auth.phone_code');
    expect(w.sent[1].body).toMatch(/^Votre code de vérification est: \d{6}$/);
    expect(w.sent[1].options.locale).toBe('fr');
  });
});

describe('a new account', () => {
  it('opens in the language the app showed, and the first mail is written in it', async () => {
    const w = await makeWorld();

    await w.auth.register({ email: 'nour@mail.tn', password: 'Secret1234', name: 'Nour' }, 'ar');

    const row = w.memory.rows('user').find((entry) => entry.email === 'nour@mail.tn') as any;

    expect(row.locale).toBe('ar');
    expect(w.sent.length).toBe(1);
    expect(ARABIC.test(w.sent[0].subject ?? '')).toBe(true);
    expect(w.sent[0].body).toMatch(/[؀-ۿ]/);
    expect(w.sent[0].body).toContain('https://app.example.tn/verify-email?token=');
  });

  it('without a language it opens in French', async () => {
    const w = await makeWorld();

    await w.auth.register({ email: 'nour@mail.tn', password: 'Secret1234', name: 'Nour' });

    const row = w.memory.rows('user').find((entry) => entry.email === 'nour@mail.tn') as any;

    expect(row.locale).toBe('fr');
    expect(w.sent[0].subject).toBe('Vérification de votre email');
  });
});

describe('the link to choose a password, sent by the back office', () => {
  it('to a technician who chose Arabic: Arabic; to a French customer: French; to a staff member: French', async () => {
    const w = await makeWorld();

    await w.users.reissuePasswordSetupLink(w.arabicArtisan.id as number);
    await w.users.reissuePasswordSetupLink(w.frenchClient.id as number);
    await w.users.reissuePasswordSetupLink(w.arabicAdmin.id as number);

    expect(w.sent[0].subject).toBe('إنشاء كلمة المرور');
    expect(w.sent[0].body).toMatch(/^تم إنشاء حسابك في Smart-Dépannage\. اختر كلمة المرور \(الرابط صالح لمدة 24 ساعة ولمرة واحدة\): https:\/\/\S+$/);
    expect(w.sent[1].subject).toBe('Création de votre mot de passe');
    expect(w.sent[1].body).toMatch(/^Votre compte Smart Dépannage a été créé\. Choisissez votre mot de passe \(lien valable 24 heures, usage unique\) : https:\/\/\S+$/);
    expect(w.sent[2].subject).toBe('Création de votre mot de passe');
    expect(w.sent[2].options.locale).toBe('fr');
  });

  it('the link in the Arabic mail is the link, whole', async () => {
    const w = await makeWorld();

    await w.users.reissuePasswordSetupLink(w.arabicArtisan.id as number);

    const url = link(w.sent[0].body);

    expect(url.startsWith('https://app.example.tn/')).toBe(true);
    expect(w.sent[0].body.endsWith(url)).toBe(true);
    expect(w.sent[0].body.includes(FSI)).toBe(false);
    expect(w.sent[0].body.includes(PDI)).toBe(false);
  });
});
