import * as argon2 from 'argon2';

import { FakeTable, withTransactions } from '../../common/testing/fake-tables';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { ContactChangeService } from './contact-change.service';

process.env.FRONTEND_URL = 'https://app.example.tn';

const PASSWORD = 'Secret123';

type World = Awaited<ReturnType<typeof makeWorld>>;

async function makeWorld(options: { emailConfigured?: boolean; smsConfigured?: boolean } = {}) {
  const users = new FakeTable({
    unique: ['email', 'phoneKey'],
    defaults: () => ({
      name: 'Amel',
      isActive: true,
      isGuest: false,
      deletedAt: null,
      phone: null,
      phoneKey: null,
      emailVerifiedAt: null,
      phoneVerifiedAt: null,
    }),
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
    sendEmail: async (to: string, subject: string, body: string, opts: any) => {
      sentEmails.push({ to, subject, body, options: opts });
      return { queued: true };
    },
    sendSms: async (to: string, body: string, opts: any) => {
      sentSms.push({ to, body, options: opts });
      return { queued: true };
    },
    isEmailSimulated: () => options.emailConfigured === false,
    isSmsSimulated: () => options.smsConfigured === false,
  };

  const service = new ContactChangeService(prisma, notifications, new RateLimitService());
  const password = await argon2.hash(PASSWORD);

  const amel = users.insert({ email: 'amel@mail.tn', password, phone: '22 123 456', phoneKey: '+21622123456' });
  const other = users.insert({ email: 'other@mail.tn', password, name: 'Other', phone: '98 765 432', phoneKey: '+21698765432' });

  return { users, authToken, intervention, prisma, service, sentEmails, sentSms, amel, other, password };
}

const tokenOf = (mail: { body: string }) => mail.body.match(/token=([a-f0-9]+)/)![1];
const codeOf = (sms: { body: string }) => sms.body.match(/\d{6}/)![0];

async function failure(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('expected a failure');
}

describe('ContactChangeService: e-mail', () => {
  it('needs the current password, and counts the wrong ones', async () => {
    const w = await makeWorld();

    for (let attempt = 0; attempt < 5; attempt++) {
      const error = await failure(w.service.requestEmailChange(w.amel.id, { newEmail: 'new@mail.tn', currentPassword: 'wrong' }));
      expect(error.status).toBe(400);
    }

    // the sixth try is locked out, even with the right password
    const locked = await failure(w.service.requestEmailChange(w.amel.id, { newEmail: 'new@mail.tn', currentPassword: PASSWORD }));
    expect(locked.status).toBe(429);
    expect(w.sentEmails.length).toBe(0);
    expect(w.authToken.rows.length).toBe(0);
  });

  it('sends the link to the NEW address only, and changes nothing before it is clicked', async () => {
    const w = await makeWorld();

    const answer = await w.service.requestEmailChange(w.amel.id, { newEmail: '  New@Mail.tn ', currentPassword: PASSWORD });

    expect(answer.sent).toBe(true);
    expect(w.sentEmails.length).toBe(1);
    expect(w.sentEmails[0].to).toBe('new@mail.tn');
    expect(w.sentEmails[0].options.template.key).toBe('auth.email_change');
    expect(w.users.rows.find((u) => u.id === w.amel.id)!.email).toBe('amel@mail.tn');

    const stored = w.authToken.rows[0];
    expect(stored.type).toBe('EMAIL_CHANGE');
    expect(stored.newValue).toBe('new@mail.tn');
    // only the hash is stored, never the link's token
    expect(stored.tokenHash.includes(tokenOf(w.sentEmails[0]))).toBe(false);
  });

  it('confirms with the link: new address, verified, old links dead, old mailbox told', async () => {
    const w = await makeWorld();

    await w.authToken.create({ data: { userId: w.amel.id, type: 'PASSWORD_RESET', tokenHash: 'reset-hash', expiresAt: new Date(Date.now() + 1e6) } });
    await w.authToken.create({ data: { userId: w.amel.id, type: 'EMAIL_VERIFICATION', tokenHash: 'verify-hash', expiresAt: new Date(Date.now() + 1e6) } });

    await w.service.requestEmailChange(w.amel.id, { newEmail: 'new@mail.tn', currentPassword: PASSWORD });
    const result = await w.service.confirmEmailChange(tokenOf(w.sentEmails[0]));

    expect(result.message.length > 0).toBe(true);

    const user = w.users.rows.find((u) => u.id === w.amel.id)!;
    expect(user.email).toBe('new@mail.tn');
    expect(user.emailVerifiedAt instanceof Date).toBe(true);

    // a reset link sent to the old mailbox must not work any more
    expect(w.authToken.rows.find((t) => t.tokenHash === 'reset-hash')!.revokedAt instanceof Date).toBe(true);
    expect(w.authToken.rows.find((t) => t.tokenHash === 'verify-hash')!.revokedAt instanceof Date).toBe(true);

    expect(w.sentEmails.length).toBe(2);
    expect(w.sentEmails[1].to).toBe('amel@mail.tn');
    expect(w.sentEmails[1].body.includes('new@mail.tn')).toBe(false); // masked
    expect(w.sentEmails[1].body.includes('n***@m***.tn')).toBe(true);
  });

  it('a link works once', async () => {
    const w = await makeWorld();

    await w.service.requestEmailChange(w.amel.id, { newEmail: 'new@mail.tn', currentPassword: PASSWORD });
    const token = tokenOf(w.sentEmails[0]);

    await w.service.confirmEmailChange(token);

    const error = await failure(w.service.confirmEmailChange(token));
    expect(error.status).toBe(400);
  });

  it('a newer request kills the older link', async () => {
    const w = await makeWorld();

    await w.service.requestEmailChange(w.amel.id, { newEmail: 'first@mail.tn', currentPassword: PASSWORD });
    await w.service.requestEmailChange(w.amel.id, { newEmail: 'second@mail.tn', currentPassword: PASSWORD });

    const stale = await failure(w.service.confirmEmailChange(tokenOf(w.sentEmails[0])));
    expect(stale.status).toBe(400);

    await w.service.confirmEmailChange(tokenOf(w.sentEmails[1]));
    expect(w.users.rows.find((u) => u.id === w.amel.id)!.email).toBe('second@mail.tn');
  });

  it('an expired link is refused', async () => {
    const w = await makeWorld();

    await w.service.requestEmailChange(w.amel.id, { newEmail: 'new@mail.tn', currentPassword: PASSWORD });
    w.authToken.rows[0].expiresAt = new Date(Date.now() - 1000);

    const error = await failure(w.service.confirmEmailChange(tokenOf(w.sentEmails[0])));
    expect(error.status).toBe(400);
    expect(w.users.rows.find((u) => u.id === w.amel.id)!.email).toBe('amel@mail.tn');
  });

  it('refuses an address that is taken, is the same, or cannot receive mail', async () => {
    const w = await makeWorld();

    const taken = await failure(w.service.requestEmailChange(w.amel.id, { newEmail: 'OTHER@mail.tn', currentPassword: PASSWORD }));
    expect(taken.status).toBe(409);

    const same = await failure(w.service.requestEmailChange(w.amel.id, { newEmail: 'amel@mail.tn', currentPassword: PASSWORD }));
    expect(same.status).toBe(400);

    const reserved = await failure(w.service.requestEmailChange(w.amel.id, { newEmail: 'x@guest.smart-depannage.local', currentPassword: PASSWORD }));
    expect(reserved.status).toBe(400);

    expect(w.sentEmails.length).toBe(0);
  });

  it('somebody else taking the address in the meantime stops the change', async () => {
    const w = await makeWorld();

    await w.service.requestEmailChange(w.amel.id, { newEmail: 'new@mail.tn', currentPassword: PASSWORD });
    w.users.insert({ email: 'new@mail.tn', password: w.password });

    const error = await failure(w.service.confirmEmailChange(tokenOf(w.sentEmails[0])));

    expect(error.status).toBe(409);
    expect(w.users.rows.find((u) => u.id === w.amel.id)!.email).toBe('amel@mail.tn');
  });

  it('guests and disabled accounts cannot', async () => {
    const w = await makeWorld();
    const guest = w.users.insert({ email: 'guest_1@guest.smart-depannage.local', password: w.password, isGuest: true });
    const gone = w.users.insert({ email: 'gone@mail.tn', password: w.password, isActive: false });

    expect((await failure(w.service.requestEmailChange(guest.id, { newEmail: 'a@mail.tn', currentPassword: PASSWORD }))).status).toBe(400);
    expect((await failure(w.service.requestEmailChange(gone.id, { newEmail: 'b@mail.tn', currentPassword: PASSWORD }))).status).toBe(401);
  });

  it('at most three links an hour per account', async () => {
    const w = await makeWorld();

    for (const address of ['a@mail.tn', 'b@mail.tn', 'c@mail.tn']) {
      await w.service.requestEmailChange(w.amel.id, { newEmail: address, currentPassword: PASSWORD });
    }

    const error = await failure(w.service.requestEmailChange(w.amel.id, { newEmail: 'd@mail.tn', currentPassword: PASSWORD }));
    expect(error.status).toBe(429);
  });

  it('says plainly when no mail server is configured', async () => {
    const w = await makeWorld({ emailConfigured: false });

    const answer = await w.service.requestEmailChange(w.amel.id, { newEmail: 'new@mail.tn', currentPassword: PASSWORD });

    expect(answer.sent).toBe(false);
  });
});

describe('ContactChangeService: phone', () => {
  it('sends a code to the NEW number and changes nothing before it is typed', async () => {
    const w = await makeWorld();

    const answer = await w.service.requestPhoneChange(w.amel.id, { newPhone: '55 111 222', currentPassword: PASSWORD });

    expect(answer.sent).toBe(true);
    expect(w.sentSms.length).toBe(1);
    expect(w.sentSms[0].to).toBe('55 111 222');
    expect(w.users.rows.find((u) => u.id === w.amel.id)!.phone).toBe('22 123 456');

    const stored = w.authToken.rows[0];
    expect(stored.type).toBe('PHONE_CHANGE');
    expect(stored.newValue).toBe('55 111 222');
    expect(stored.tokenHash.includes(codeOf(w.sentSms[0]))).toBe(false);
  });

  it('confirms with the code: number, key and verification, then tells the e-mail address', async () => {
    const w = await makeWorld();

    await w.service.requestPhoneChange(w.amel.id, { newPhone: '55 111 222', currentPassword: PASSWORD });
    const result = await w.service.confirmPhoneChange(w.amel.id, codeOf(w.sentSms[0]));

    expect(result.message.length > 0).toBe(true);

    const user = w.users.rows.find((u) => u.id === w.amel.id)!;
    expect(user.phone).toBe('55 111 222');
    expect(user.phoneKey).toBe('+21655111222');
    expect(user.phoneVerifiedAt instanceof Date).toBe(true);

    expect(w.sentEmails.length).toBe(1);
    expect(w.sentEmails[0].to).toBe('amel@mail.tn');
    expect(w.sentEmails[0].body.includes('55111222')).toBe(false);
  });

  it('a code works once, only for its own user, and a wrong one is counted', async () => {
    const w = await makeWorld();

    await w.service.requestPhoneChange(w.amel.id, { newPhone: '55 111 222', currentPassword: PASSWORD });
    const code = codeOf(w.sentSms[0]);

    // somebody else's session cannot use Amel's code
    expect((await failure(w.service.confirmPhoneChange(w.other.id, code))).status).toBe(400);

    await w.service.confirmPhoneChange(w.amel.id, code);
    expect((await failure(w.service.confirmPhoneChange(w.amel.id, code))).status).toBe(400);
  });

  it('five wrong codes lock the confirmation', async () => {
    const w = await makeWorld();

    await w.service.requestPhoneChange(w.amel.id, { newPhone: '55 111 222', currentPassword: PASSWORD });
    const code = codeOf(w.sentSms[0]);
    const wrong = code === '000000' ? '111111' : '000000';

    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await failure(w.service.confirmPhoneChange(w.amel.id, wrong))).status).toBe(400);
    }

    expect((await failure(w.service.confirmPhoneChange(w.amel.id, code))).status).toBe(429);
    expect(w.users.rows.find((u) => u.id === w.amel.id)!.phone).toBe('22 123 456');
  });

  it('a number someone has VERIFIED is theirs: any spelling of it is refused', async () => {
    const w = await makeWorld();
    w.users.rows.find((u) => u.id === w.other.id)!.phoneVerifiedAt = new Date();

    for (const spelling of ['98 765 432', '+216 98765432', '0021698765432', '21698765432']) {
      const error = await failure(w.service.requestPhoneChange(w.amel.id, { newPhone: spelling, currentPassword: PASSWORD }));
      expect(error.status).toBe(409);
    }

    expect(w.sentSms.length).toBe(0);
  });

  it('a number nobody has proved can be claimed by the person who does: the code is the proof, the other account is told', async () => {
    const w = await makeWorld();
    // other@mail.tn holds 98 765 432 but never verified it (a sign-up, a form)

    await w.service.requestPhoneChange(w.amel.id, { newPhone: '+216 98765432', currentPassword: PASSWORD });
    expect(w.sentSms.length).toBe(1);
    expect(w.users.rows.find((u) => u.id === w.other.id)!.phoneKey).toBe('+21698765432'); // nothing moves before the code

    await w.service.confirmPhoneChange(w.amel.id, codeOf(w.sentSms[0]));

    const amel = w.users.rows.find((u) => u.id === w.amel.id)!;
    const other = w.users.rows.find((u) => u.id === w.other.id)!;

    expect(amel.phoneKey).toBe('+21698765432');
    expect(amel.phoneVerifiedAt instanceof Date).toBe(true);
    expect(other.phone).toBe(null);
    expect(other.phoneKey).toBe(null);
    expect(other.phoneVerifiedAt).toBe(null);

    const told = w.sentEmails.find((mail) => mail.to === 'other@mail.tn');
    expect(told !== undefined).toBe(true);
    expect(told!.options.template.key).toBe('auth.phone_released_notice');
    expect(told!.body.includes('98765432')).toBe(false);
  });

  it('a number verified between the request and the code can no longer be taken', async () => {
    const w = await makeWorld();

    await w.service.requestPhoneChange(w.amel.id, { newPhone: '98 765 432', currentPassword: PASSWORD });
    w.users.rows.find((u) => u.id === w.other.id)!.phoneVerifiedAt = new Date();

    expect((await failure(w.service.confirmPhoneChange(w.amel.id, codeOf(w.sentSms[0])))).status).toBe(409);
    expect(w.users.rows.find((u) => u.id === w.other.id)!.phoneKey).toBe('+21698765432');
    expect(w.users.rows.find((u) => u.id === w.amel.id)!.phoneKey).toBe('+21622123456');
  });

  it('refuses your own number, and what is not a number', async () => {
    const w = await makeWorld();

    expect((await failure(w.service.requestPhoneChange(w.amel.id, { newPhone: '+216 22123456', currentPassword: PASSWORD }))).status).toBe(400);
    expect((await failure(w.service.requestPhoneChange(w.amel.id, { newPhone: 'not a number', currentPassword: PASSWORD }))).status).toBe(400);
    expect((await failure(w.service.requestPhoneChange(w.amel.id, { newPhone: '55 111 222', currentPassword: 'wrong' }))).status).toBe(400);
    expect(w.sentSms.length).toBe(0);
  });

  it('somebody taking the number in the meantime stops the change and keeps the old one', async () => {
    const w = await makeWorld();

    await w.service.requestPhoneChange(w.amel.id, { newPhone: '55 111 222', currentPassword: PASSWORD });
    w.users.insert({ email: 'late@mail.tn', password: w.password, phone: '55111222', phoneKey: '+21655111222', phoneVerifiedAt: new Date() });

    const error = await failure(w.service.confirmPhoneChange(w.amel.id, codeOf(w.sentSms[0])));

    expect(error.status).toBe(409);
    expect(w.users.rows.find((u) => u.id === w.amel.id)!.phoneKey).toBe('+21622123456');
  });

  it('adds a first number to an account that had none', async () => {
    const w = await makeWorld();
    const bare = w.users.insert({ email: 'bare@mail.tn', password: w.password });

    await w.service.requestPhoneChange(bare.id, { newPhone: '55 111 222', currentPassword: PASSWORD });
    await w.service.confirmPhoneChange(bare.id, codeOf(w.sentSms[0]));

    expect(w.users.rows.find((u) => u.id === bare.id)!.phoneKey).toBe('+21655111222');
  });

  it('at most three codes an hour per account', async () => {
    const w = await makeWorld();

    for (const number of ['55 111 222', '55 111 223', '55 111 224']) {
      await w.service.requestPhoneChange(w.amel.id, { newPhone: number, currentPassword: PASSWORD });
    }

    expect((await failure(w.service.requestPhoneChange(w.amel.id, { newPhone: '55 111 225', currentPassword: PASSWORD }))).status).toBe(429);
  });
});

describe('ContactChangeService: review, pass 2', () => {
  it('claiming an unproven number keeps a way to call the evicted account\'s customers back', async () => {
    const w = await makeWorld();
    w.intervention.insert({ clientId: w.other.id, serviceType: 'PLOMBIER' });
    w.intervention.insert({ clientId: w.other.id, serviceType: 'PLOMBIER', contactPhone: '11 000 000', contactName: 'Already set' });

    await w.service.requestPhoneChange(w.amel.id, { newPhone: '98 765 432', currentPassword: PASSWORD });
    await w.service.confirmPhoneChange(w.amel.id, codeOf(w.sentSms[0]));

    expect(w.users.rows.find((u) => u.id === w.other.id)!.phoneKey).toBe(null);
    expect(w.intervention.rows[0].contactPhone).toBe('98 765 432');
    expect(w.intervention.rows[0].contactName).toBe('Other');
    expect(w.intervention.rows[1].contactPhone).toBe('11 000 000'); // what the request already had is kept
    expect(w.intervention.rows[1].contactName).toBe('Already set');
  });

  it('an address that only a guest profile has can be claimed with the link; the guest keeps its requests under a made-up address', async () => {
    const w = await makeWorld();
    const guest = w.users.insert({ email: 'taken@mail.tn', password: w.password, isGuest: true });
    await w.authToken.create({ data: { userId: guest.id, type: 'GUEST_MAGIC_LINK', tokenHash: 'g-link', expiresAt: new Date(Date.now() + 1e6) } });

    await w.service.requestEmailChange(w.amel.id, { newEmail: 'Taken@mail.tn', currentPassword: PASSWORD });
    expect(w.users.rows.find((u) => u.id === guest.id)!.email).toBe('taken@mail.tn'); // nothing moves before the click

    await w.service.confirmEmailChange(tokenOf(w.sentEmails[0]));

    expect(w.users.rows.find((u) => u.id === w.amel.id)!.email).toBe('taken@mail.tn');
    expect(w.users.rows.find((u) => u.id === guest.id)!.email.endsWith('@guest.smart-depannage.local')).toBe(true);
    expect(w.users.rows.find((u) => u.id === guest.id)!.isGuest).toBe(true);
    expect(w.authToken.rows.find((t) => t.tokenHash === 'g-link')!.revokedAt instanceof Date).toBe(true);
  });

  it('a REAL account\'s address is never taken, not even if the holder stopped being a guest between request and click', async () => {
    const w = await makeWorld();
    const guest = w.users.insert({ email: 'taken@mail.tn', password: w.password, isGuest: true });

    await w.service.requestEmailChange(w.amel.id, { newEmail: 'taken@mail.tn', currentPassword: PASSWORD });
    w.users.rows.find((u) => u.id === guest.id)!.isGuest = false; // the holder activated their account meanwhile

    expect((await failure(w.service.confirmEmailChange(tokenOf(w.sentEmails[0])))).status).toBe(409);
    expect(w.users.rows.find((u) => u.id === w.amel.id)!.email).toBe('amel@mail.tn');
    expect(w.users.rows.find((u) => u.id === guest.id)!.email).toBe('taken@mail.tn');

    expect((await failure(w.service.requestEmailChange(w.amel.id, { newEmail: 'other@mail.tn', currentPassword: PASSWORD }))).status).toBe(409);
  });

  it('one account cannot use up what a number may receive: a second account still gets its code', async () => {
    const w = await makeWorld();
    const second = w.users.insert({ email: 'second@mail.tn', password: w.password });

    for (const number of ['55 111 222', '55 111 222', '55 111 222']) {
      await w.service.requestPhoneChange(w.amel.id, { newPhone: number, currentPassword: PASSWORD });
    }

    expect((await failure(w.service.requestPhoneChange(w.amel.id, { newPhone: '55 111 222', currentPassword: PASSWORD }))).status).toBe(429);

    // the account that is over its own limit did not touch the number's quota beyond its three
    await w.service.requestPhoneChange(second.id, { newPhone: '55 111 222', currentPassword: PASSWORD });
    expect(w.sentSms.length).toBe(4);
  });

  it('start-up does not count deleted accounts: they keep the text of their number and no key, on purpose', async () => {
    const w = await makeWorld();
    const lines: string[] = [];
    (w.service as any).logger = { warn: (line: string) => lines.push(line), error: (line: string) => lines.push(line) };

    w.users.insert({ email: 'gone@mail.tn', password: w.password, isActive: false, deletedAt: new Date(), phone: '55 111 222', phoneKey: null });
    await w.service.onApplicationBootstrap();

    expect(lines).toEqual([]);
  });
});

describe('ContactChangeService: races and start-up', () => {
  it('the database refusing the number at the last moment (unique key) is a 409, and the old number stays', async () => {
    const w = await makeWorld();

    await w.service.requestPhoneChange(w.amel.id, { newPhone: '55 111 222', currentPassword: PASSWORD });

    // another request wins the number between the lookup and the write
    const realUpdate = w.users.update.bind(w.users);
    w.users.update = async (args: any) => {
      if (args?.where?.id === w.amel.id && args?.data?.phoneKey) {
        throw Object.assign(new Error('unique'), { code: 'P2002', meta: { driverAdapterError: { cause: { constraint: { fields: ['phoneKey'] } } } } });
      }

      return realUpdate(args);
    };

    const error = await failure(w.service.confirmPhoneChange(w.amel.id, codeOf(w.sentSms[0])));

    expect(error.status).toBe(409);
    expect(w.users.rows.find((u) => u.id === w.amel.id)!.phoneKey).toBe('+21622123456');
  });

  it('start-up says how many accounts have a number without a key, and never stops the server', async () => {
    const w = await makeWorld();
    const lines: string[] = [];
    (w.service as any).logger = { warn: (line: string) => lines.push(line), error: (line: string) => lines.push(line) };

    await w.service.onApplicationBootstrap();
    expect(lines).toEqual([]);

    w.users.insert({ email: 'old@mail.tn', password: w.password, phone: '55 111 222', phoneKey: null });
    await w.service.onApplicationBootstrap();
    expect(lines.length).toBe(1);
    expect(lines[0].startsWith('1 account(s)')).toBe(true);
    expect(lines[0].includes('55')).toBe(false);
    expect(lines[0].includes('phones:backfill')).toBe(true);

    (w.service as any).prisma = { user: { count: async () => { throw new Error('column "phoneKey" does not exist'); } } };
    await w.service.onApplicationBootstrap();
    expect(lines.length).toBe(2);
    expect(lines[1].includes('does not exist')).toBe(false); // the error text is never logged
    expect(lines[1].includes('phones:backfill')).toBe(true);
  });
});

describe('ContactChangeService: staff corrections', () => {
  it('posting the number the account already has changes nothing, even when it was never a readable phone number', async () => {
    const w = await makeWorld();
    const seeded = w.users.insert({ email: 'admin@mail.tn', password: w.password, phone: '21600000000', phoneKey: null });

    const change = await w.service.prepareAdminChange(seeded, { phone: '21600000000' });

    expect(change.data).toEqual({});
    expect(change.phoneChangedFrom).toBe(undefined);

    // a different one is still checked
    expect((await failure(w.service.prepareAdminChange(seeded, { phone: 'abc' }))).status).toBe(400);
  });

  it('a new e-mail resets its verification, is unique, and kills the old links and tells the old mailbox', async () => {
    const w = await makeWorld();
    w.users.rows.find((u) => u.id === w.amel.id)!.emailVerifiedAt = new Date();
    await w.authToken.create({ data: { userId: w.amel.id, type: 'PASSWORD_RESET', tokenHash: 'reset-hash', expiresAt: new Date(Date.now() + 1e6) } });

    expect((await failure(w.service.prepareAdminChange(w.amel, { email: 'other@mail.tn' }))).status).toBe(409);

    const change = await w.service.prepareAdminChange(w.amel, { email: ' Fixed@Mail.tn ' });

    expect(change.data).toEqual({ email: 'fixed@mail.tn', emailVerifiedAt: null });
    expect(change.emailChangedFrom).toBe('amel@mail.tn');

    await w.service.revokeAfterAdminChange(w.prisma, w.amel.id, change);
    await w.service.noticeAfterAdminChange(w.amel, change, { email: 'fixed@mail.tn' });

    expect(w.authToken.rows[0].revokedAt instanceof Date).toBe(true);
    expect(w.sentEmails.length).toBe(1);
    expect(w.sentEmails[0].to).toBe('amel@mail.tn');
  });

  it('the same e-mail or the same number written differently changes nothing that matters', async () => {
    const w = await makeWorld();

    const change = await w.service.prepareAdminChange(w.amel, { email: 'AMEL@mail.tn', phone: '+216 22 123 456' });

    expect(change.emailChangedFrom).toBeUndefined();
    expect(change.phoneChangedFrom).toBeUndefined();
    // the spelling is updated, the number stays verified
    expect(change.data).toEqual({ phone: '+216 22 123 456', phoneKey: '+21622123456' });
  });

  it('a new number is unique and unverified; an empty one removes it', async () => {
    const w = await makeWorld();

    expect((await failure(w.service.prepareAdminChange(w.amel, { phone: '98765432' }))).status).toBe(409);
    expect((await failure(w.service.prepareAdminChange(w.amel, { phone: 'abc' }))).status).toBe(400);

    const moved = await w.service.prepareAdminChange(w.amel, { phone: '55 111 222' });
    expect(moved.data).toEqual({ phone: '55 111 222', phoneKey: '+21655111222', phoneVerifiedAt: null });

    const removed = await w.service.prepareAdminChange(w.amel, { phone: '' });
    expect(removed.data).toEqual({ phone: null, phoneKey: null, phoneVerifiedAt: null });
  });
});
