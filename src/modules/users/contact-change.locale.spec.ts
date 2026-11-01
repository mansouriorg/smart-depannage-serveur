import * as argon2 from 'argon2';

import { FakeTable, withTransactions } from '../../common/testing/fake-tables';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { ContactChangeService } from './contact-change.service';

process.env.FRONTEND_URL = 'https://app.example.tn';

const FSI = '⁨';
const PDI = '⁩';
const PASSWORD = 'Secret123';

/**
 * Changing an e-mail address or a phone number (P3-04): the link, the code and the notices are written in the language of the account;
 * the back office is written to in French whatever it stored.
 */
async function makeWorld() {
  const users = new FakeTable({
    unique: ['email', 'phoneKey'],
    honourSelect: true,
    defaults: () => ({ name: 'Amel', role: 'CLIENT', locale: 'fr', isActive: true, isGuest: false, deletedAt: null, phone: null, phoneKey: null, emailVerifiedAt: null, phoneVerifiedAt: null }),
  });
  const authToken = new FakeTable({
    unique: ['tokenHash'],
    defaults: () => ({ usedAt: null, revokedAt: null, newValue: null }),
    include: { user: (row) => users.rows.find((user) => user.id === row.userId) },
  });
  const intervention = new FakeTable({ defaults: () => ({ contactPhone: null, contactName: null }) });
  const prisma: any = withTransactions({ user: users, authToken, intervention }, [users, authToken, intervention]);

  const sentEmails: Array<{ to: string; subject: string; body: string; options: any }> = [];
  const sentSms: Array<{ to: string; body: string; options: any }> = [];
  const notifications: any = {
    sendEmail: async (to: string, subject: string, body: string, options: any) => (sentEmails.push({ to, subject, body, options }), { queued: true }),
    sendSms: async (to: string, body: string, options: any) => (sentSms.push({ to, body, options }), { queued: true }),
    isEmailSimulated: () => false,
    isSmsSimulated: () => false,
  };

  const service = new ContactChangeService(prisma, notifications, new RateLimitService());
  const password = await argon2.hash(PASSWORD);

  const arabic = users.insert({ email: 'sami@mail.tn', password, name: 'Sami', locale: 'ar', phone: '22 123 456', phoneKey: '+21622123456' });
  const french = users.insert({ email: 'karim@mail.tn', password, name: 'Karim', locale: 'fr', phone: '98 765 432', phoneKey: '+21698765432' });
  const staff = users.insert({ email: 'chef@mail.tn', password, name: 'Chef', role: 'ADMIN', locale: 'ar', phone: '97 111 222', phoneKey: '+21697111222' });

  return { service, users, sentEmails, sentSms, arabic, french, staff };
}

const tokenOf = (body: string) => body.match(/token=([a-f0-9]+)/)![1];

describe('changing the e-mail address, in the language of the account (P3-04)', () => {
  it('the link to the new address: Arabic with the link bare, French for a French account, French for the back office', async () => {
    const w = await makeWorld();

    await w.service.requestEmailChange(w.arabic.id, { newEmail: 'new1@mail.tn', currentPassword: PASSWORD });
    await w.service.requestEmailChange(w.french.id, { newEmail: 'new2@mail.tn', currentPassword: PASSWORD });
    await w.service.requestEmailChange(w.staff.id, { newEmail: 'new3@mail.tn', currentPassword: PASSWORD });

    expect(w.sentEmails[0].subject).toBe('تأكيد عنوان بريدك الإلكتروني الجديد');
    expect(w.sentEmails[0].body).toMatch(/^اضغط على هذا الرابط لتأكيد هذا العنوان كعنوان لحسابك \(صالح لمدة ساعة واحدة\): https:\/\/app\.example\.tn\S+$/);
    expect(w.sentEmails[0].options.locale).toBe('ar');
    expect(w.sentEmails[1].subject).toBe('Confirmez votre nouvelle adresse e-mail');
    expect(w.sentEmails[1].body).toMatch(/^Cliquez sur ce lien pour confirmer cette adresse comme adresse de votre compte \(valable 1 heure\): https:/);
    expect(w.sentEmails[2].subject).toBe('Confirmez votre nouvelle adresse e-mail');
    expect(w.sentEmails[2].options.locale).toBe('fr');
  });

  it('the notice to the old address, once the change is made, is in the language of the account', async () => {
    const w = await makeWorld();

    await w.service.requestEmailChange(w.arabic.id, { newEmail: 'new1@mail.tn', currentPassword: PASSWORD });
    await w.service.confirmEmailChange(tokenOf(w.sentEmails[0].body));

    const notice = w.sentEmails[1];

    expect(notice.to).toBe('sami@mail.tn');
    expect(notice.subject).toBe('تم تغيير عنوان البريد الإلكتروني لحسابك');
    expect(notice.body).toContain(FSI);
    expect(notice.body).toContain(PDI);
    expect(notice.options.locale).toBe('ar');
    expect(notice.options.template.key).toBe('auth.email_changed_notice');
  });
});

describe('changing the phone number, in the language of the account (P3-04)', () => {
  it('the code by SMS: Arabic for an Arabic account (the code is plain digits, not set apart), French otherwise', async () => {
    const w = await makeWorld();

    await w.service.requestPhoneChange(w.arabic.id, { newPhone: '55 333 444', currentPassword: PASSWORD });
    await w.service.requestPhoneChange(w.french.id, { newPhone: '55 333 555', currentPassword: PASSWORD });

    expect(w.sentSms[0].body).toMatch(/^رمز التحقّق الخاص بك هو: \d{6}$/);
    expect(w.sentSms[0].options.locale).toBe('ar');
    expect(w.sentSms[1].body).toMatch(/^Votre code de vérification est: \d{6}$/);
    expect(w.sentSms[1].options.locale).toBe('fr');
  });
});

describe('the notices after a phone number is changed, in the language of each account (P3-04)', () => {
  /** The account asks for the number, proves it with the code, and the e-mails sent by the confirmation are returned. */
  async function confirmed(w: Awaited<ReturnType<typeof makeWorld>>, userId: number, newPhone: string) {
    await w.service.requestPhoneChange(userId, { newPhone, currentPassword: PASSWORD });

    const code = w.sentSms[w.sentSms.length - 1].body.match(/(\d{6})/)![1];

    w.sentEmails.length = 0;
    await w.service.confirmPhoneChange(userId, code);

    return [...w.sentEmails];
  }

  it('Arabic: the notice to the address of the account is Arabic, with the number set apart and the Arabic template looked for', async () => {
    const w = await makeWorld();
    const mails = await confirmed(w, w.arabic.id, '55 333 444');
    const notice = mails.find((mail) => mail.to === 'sami@mail.tn')!;

    expect(notice.subject).toBe('تم تغيير رقم هاتف حسابك');
    expect(notice.body).toContain('أصبح رقم هاتف حسابك');
    expect(notice.body).toContain(FSI);
    expect(notice.options.locale).toBe('ar');
    expect(notice.options.template.key).toBe('auth.phone_changed_notice');
  });

  it('French: the notice it always was', async () => {
    const w = await makeWorld();
    const mails = await confirmed(w, w.french.id, '55 333 555');
    const notice = mails.find((mail) => mail.to === 'karim@mail.tn')!;

    expect(notice.subject).toBe('Le numéro de téléphone de votre compte a changé');
    expect(notice.options.locale).toBe('fr');
  });

  it('the account that held the number without proving it is told that it lost it, in its own language, whoever claimed the number', async () => {
    const w = await makeWorld();

    w.users.insert({ email: 'holder-ar@mail.tn', name: 'Hela', locale: 'ar', phone: '55 333 444', phoneKey: '+21655333444', isGuest: true });
    w.users.insert({ email: 'holder-fr@mail.tn', name: 'Hedi', locale: 'fr', phone: '55 333 555', phoneKey: '+21655333555', isGuest: true });

    const first = await confirmed(w, w.french.id, '55 333 444');
    const second = await confirmed(w, w.arabic.id, '55 333 555');

    const toArabic = first.find((mail) => mail.to === 'holder-ar@mail.tn')!;
    const toFrench = second.find((mail) => mail.to === 'holder-fr@mail.tn')!;

    expect(toArabic.subject).toBe('تمت إزالة رقم الهاتف من حسابك');
    expect(toArabic.options.locale).toBe('ar');
    expect(toArabic.options.template.key).toBe('auth.phone_released_notice');
    expect(toFrench.subject).toBe('Le numéro de téléphone de votre compte a été retiré');
    expect(toFrench.options.locale).toBe('fr');
  });
});

describe('the notices after the back office changed an address or a number (P3-04)', () => {
  it('the account is told in its own language, at its old e-mail address for an address and at its current one for a number', async () => {
    const w = await makeWorld();

    await w.service.noticeAfterAdminChange({ id: w.arabic.id, name: 'Sami' }, { emailChangedFrom: 'sami-old@mail.tn' }, { email: 'sami@mail.tn' });
    await w.service.noticeAfterAdminChange({ id: w.arabic.id, name: 'Sami' }, { phoneChangedFrom: '22 123 456' }, { phone: '55 000 111' });

    expect(w.sentEmails[0].to).toBe('sami-old@mail.tn');
    expect(w.sentEmails[0].subject).toBe('تم تغيير عنوان البريد الإلكتروني لحسابك');
    expect(w.sentEmails[0].options.locale).toBe('ar');
    expect(w.sentEmails[1].to).toBe('sami@mail.tn');
    expect(w.sentEmails[1].subject).toBe('تم تغيير رقم هاتف حسابك');
    expect(w.sentEmails[1].options.locale).toBe('ar');
  });

  it('a French account is told in French, and so is a member of the back office whose own record says Arabic', async () => {
    const w = await makeWorld();

    await w.service.noticeAfterAdminChange({ id: w.french.id, name: 'Karim' }, { emailChangedFrom: 'karim-old@mail.tn' }, { email: 'karim@mail.tn' });
    await w.service.noticeAfterAdminChange({ id: w.staff.id, name: 'Chef' }, { emailChangedFrom: 'chef-old@mail.tn' }, { email: 'chef@mail.tn' });
    await w.service.noticeAfterAdminChange({ id: w.staff.id, name: 'Chef' }, { phoneChangedFrom: '97 111 222' }, { phone: '55 000 222' });

    expect(w.sentEmails.map((mail) => mail.options.locale)).toEqual(['fr', 'fr', 'fr']);
    expect(w.sentEmails[0].subject).toBe("L'adresse e-mail de votre compte a changé");
    expect(w.sentEmails[2].subject).toBe('Le numéro de téléphone de votre compte a changé');
    expect(w.sentEmails.some((mail) => /[؀-ۿ]/.test(mail.subject + mail.body))).toBe(false);
  });

  it('nothing is sent when nothing changed', async () => {
    const w = await makeWorld();

    await w.service.noticeAfterAdminChange({ id: w.arabic.id, name: 'Sami' }, {}, {});

    expect(w.sentEmails).toEqual([]);
  });
});
