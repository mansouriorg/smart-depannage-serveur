import * as argon2 from 'argon2';
import { createHash } from 'crypto';

import { hashOneTimeCode } from '../../common/auth/one-time-code';
import { FakeTable, withTransactions } from '../../common/testing/fake-tables';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { GuestService } from './guest.service';

process.env.FRONTEND_URL = 'https://app.example.tn';

const GENERATED = 'guest_1@guest.smart-depannage.local';

async function makeWorld() {
  const users = new FakeTable({
    unique: ['email', 'phoneKey'],
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
    }),
  });
  const authToken = new FakeTable({ unique: ['tokenHash'], defaults: () => ({ usedAt: null, revokedAt: null, newValue: null }) });
  const prisma: any = withTransactions({ user: users, authToken }, [users, authToken]);

  const sentEmails: Array<{ to: string; body: string }> = [];
  const sentSms: Array<{ to: string; body: string }> = [];
  const notifications: any = {
    sendEmail: async (to: string, _subject: string, body: string) => {
      sentEmails.push({ to, body });
      return { queued: true };
    },
    sendSms: async (to: string, body: string) => {
      sentSms.push({ to, body });
      return { queued: true };
    },
  };

  const service = new GuestService(prisma, notifications, { create: async () => ({}) } as any, new RateLimitService());
  const password = await argon2.hash('Unusable-Guest-Secret');

  return { users, authToken, service, sentEmails, sentSms, password };
}

const tokenIn = (body: string) => body.match(/token=([a-f0-9]+)/)![1];
const codeIn = (body: string) => body.match(/\b(\d{6})\b/)![1];

async function failure(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('expected a failure');
}

const request = (contactPhone: string, extra: Record<string, unknown> = {}) =>
  ({ contactPhone, serviceType: 'PLOMBIER', description: 'Fuite', address: 'Tunis', ...extra }) as any;

describe('guest profiles and phone numbers', () => {
  it('creates a guest with the number and its key', async () => {
    const w = await makeWorld();

    const guest = await (w.service as any).findOrCreateGuestProfile(request('55 111 222', { contactName: 'Sami' }));

    expect(guest.isGuest).toBe(true);
    expect(guest.phone).toBe('55 111 222');
    expect(guest.phoneKey).toBe('+21655111222');
  });

  it('the same number written another way is the same guest', async () => {
    const w = await makeWorld();

    const first = await (w.service as any).findOrCreateGuestProfile(request('55 111 222'));
    const second = await (w.service as any).findOrCreateGuestProfile(request('+216 55111222'));

    expect(second.id).toBe(first.id);
    expect(w.users.rows.length).toBe(1);
  });

  it('a real account with that number blocks the request, whatever the spelling', async () => {
    const w = await makeWorld();
    w.users.insert({ email: 'real@mail.tn', password: w.password, phone: '55 111 222', phoneKey: '+21655111222' });

    const error = await failure((w.service as any).findOrCreateGuestProfile(request('0021655111222')));

    expect(error.status).toBe(409);
  });

  it('a deleted account still holding the number: the guest is made without it, nothing breaks', async () => {
    const w = await makeWorld();
    w.users.insert({ email: 'gone@mail.tn', password: w.password, isActive: false, deletedAt: new Date(), phone: '55 111 222', phoneKey: '+21655111222' });

    const guest = await (w.service as any).findOrCreateGuestProfile(request('55 111 222'));

    expect(guest.isGuest).toBe(true);
    expect(guest.phone).toBe(null);
    expect(guest.phoneKey).toBe(null);
  });

  it('two requests at the same moment end up on one guest profile', async () => {
    const w = await makeWorld();
    const realFindMany = w.users.findMany;
    let first = true;

    // the first lookup finds nobody; before this request inserts, the other one wins
    w.users.findMany = async (args: any) => {
      if (first) {
        first = false;
        w.users.insert({ email: 'winner@guest.smart-depannage.local', password: w.password, isGuest: true, phone: '55 111 222', phoneKey: '+21655111222' });
        return [];
      }

      return realFindMany(args);
    };

    const guest = await (w.service as any).findOrCreateGuestProfile(request('55 111 222'));

    expect(guest.email).toBe('winner@guest.smart-depannage.local');
    expect(w.users.rows.length).toBe(1);
  });

  it('a number that cannot be one is a 400', async () => {
    const w = await makeWorld();

    expect((await failure((w.service as any).findOrCreateGuestProfile(request('not a number')))).status).toBe(400);
  });
});

describe('requestAccountActivation', () => {
  it('the link goes to the mailbox, the code to the phone, and the SMS carries no link', async () => {
    const w = await makeWorld();
    w.users.insert({ email: 'sami@mail.tn', password: w.password, isGuest: true, phone: '55 111 222', phoneKey: '+21655111222' });

    await w.service.requestAccountActivation({ phone: '+216 55 111 222' });

    expect(w.sentEmails.length).toBe(1);
    expect(w.sentEmails[0].to).toBe('sami@mail.tn');
    expect(w.sentEmails[0].body.includes('token=')).toBe(true);

    expect(w.sentSms.length).toBe(1);
    expect(w.sentSms[0].to).toBe('55 111 222');
    expect(w.sentSms[0].body.includes('http')).toBe(false);
    expect(w.sentSms[0].body.includes('token')).toBe(false);
    expect(/\d{6}/.test(w.sentSms[0].body)).toBe(true);
  });

  it('a profile made from a phone number only gets the SMS and nothing else', async () => {
    const w = await makeWorld();
    w.users.insert({ email: GENERATED, password: w.password, isGuest: true, phone: '55 111 222', phoneKey: '+21655111222' });

    await w.service.requestAccountActivation({ phone: '55 111 222' });

    expect(w.sentEmails.length).toBe(0);
    expect(w.sentSms.length).toBe(1);
  });

  it('does not say whether a profile exists', async () => {
    const w = await makeWorld();
    w.users.insert({ email: 'sami@mail.tn', password: w.password, isGuest: true, phone: '55 111 222', phoneKey: '+21655111222' });

    const known = await w.service.requestAccountActivation({ phone: '55 111 222' });
    const unknown = await w.service.requestAccountActivation({ phone: '99 000 111' });
    const nonsense = await w.service.requestAccountActivation({ phone: 'abc' });

    expect(unknown).toEqual(known);
    expect(nonsense).toEqual(known);
    expect(w.sentSms.length).toBe(1);
  });

  it('three messages an hour per mailbox, however the address is written', async () => {
    const w = await makeWorld();
    w.users.insert({ email: 'sami@gmail.com', password: w.password, isGuest: true });

    // Gmail ignores dots and "+tag": these are one mailbox, so they share one quota
    for (const email of ['sami@gmail.com', 'sami@gmail.com', 'SAMI@gmail.com', 'sami@gmail.com']) {
      await w.service.requestAccountActivation({ email });
    }

    expect(w.sentEmails.length).toBe(3);

    const variants = await makeWorld();
    variants.users.insert({ email: 'sami@gmail.com', password: variants.password, isGuest: true });

    for (const email of ['s.ami@gmail.com', 'sami+1@gmail.com', 'sami+2@googlemail.com']) {
      await variants.service.requestAccountActivation({ email });
    }

    // no profile has those exact spellings, but they all used up the same mailbox's quota
    await variants.service.requestAccountActivation({ email: 'sami@gmail.com' });
    expect(variants.sentEmails.length).toBe(0);
  });

  it('three messages an hour per phone number, however it is written', async () => {
    const w = await makeWorld();
    w.users.insert({ email: GENERATED, password: w.password, isGuest: true, phone: '55 111 222', phoneKey: '+21655111222' });

    for (const phone of ['55 111 222', '+21655111222', '0021655111222', '55111222', '+216 55 111 222']) {
      await w.service.requestAccountActivation({ phone });
    }

    expect(w.sentSms.length).toBe(3);
  });

  it('when e-mail and phone name two different guests, the e-mail wins', async () => {
    const w = await makeWorld();
    w.users.insert({ email: 'a@mail.tn', password: w.password, isGuest: true, phone: '55 111 222', phoneKey: '+21655111222' });
    w.users.insert({ email: 'b@mail.tn', password: w.password, isGuest: true, phone: '55 333 444', phoneKey: '+21655333444' });

    await w.service.requestAccountActivation({ email: 'b@mail.tn', phone: '55 111 222' });

    expect(w.sentEmails[0].to).toBe('b@mail.tn');
    expect(w.sentSms[0].to).toBe('55 333 444');
  });
});

describe('activateGuestAccount', () => {
  async function guestWithOtp(w: Awaited<ReturnType<typeof makeWorld>>, email = 'sami@mail.tn') {
    const guest = w.users.insert({ email, password: w.password, isGuest: true, phone: '55 111 222', phoneKey: '+21655111222' });

    await w.service.requestAccountActivation({ phone: '55 111 222' });

    return { guest, code: codeIn(w.sentSms[0].body) };
  }

  it('the phone code activates the account and proves the PHONE only', async () => {
    const w = await makeWorld();
    const { guest, code } = await guestWithOtp(w);

    const result = await w.service.activateGuestAccount({ phone: '+216 55 111 222', otp: code, password: 'Secret123', email: 'sami@mail.tn' });

    expect(result.user.isGuest).toBe(false);

    const row = w.users.rows.find((u) => u.id === guest.id)!;
    expect(row.isGuest).toBe(false);
    expect(row.phoneVerifiedAt instanceof Date).toBe(true);
    expect(row.emailVerifiedAt).toBe(null); // the code went to the phone; it says nothing about the mailbox
    expect(await argon2.verify(row.password, 'Secret123')).toBe(true);

    // single use
    expect((await failure(w.service.activateGuestAccount({ phone: '55 111 222', otp: code, password: 'Secret123', email: 'sami@mail.tn' }))).status).toBe(400);
  });

  it('after the phone code, a verification link goes to the address that was typed (and only to it)', async () => {
    const w = await makeWorld();
    const { code } = await guestWithOtp(w);
    const before = w.sentEmails.length;

    await w.service.activateGuestAccount({ phone: '55 111 222', otp: code, password: 'Secret123', email: 'New@Mail.tn' });

    const sent = w.sentEmails.slice(before);
    expect(sent.length).toBe(1);
    expect(sent[0].to).toBe('new@mail.tn');
    expect(sent[0].body.includes('token=')).toBe(true);
  });

  it('the link from the mailbox activates the account and proves the E-MAIL only', async () => {
    const w = await makeWorld();
    const { guest } = await guestWithOtp(w);

    await w.service.activateGuestAccount({ token: tokenIn(w.sentEmails[0].body), password: 'Secret123' });

    const row = w.users.rows.find((u) => u.id === guest.id)!;
    expect(row.isGuest).toBe(false);
    expect(row.emailVerifiedAt instanceof Date).toBe(true);
    expect(row.phoneVerifiedAt).toBe(null);
  });

  it('the phone code always asks for the address: the one typed on the public form is never kept by default', async () => {
    const w = await makeWorld();
    const { guest, code } = await guestWithOtp(w, 'typed-by-someone-else@mail.tn');

    const error = await failure(w.service.activateGuestAccount({ phone: '55 111 222', otp: code, password: 'Secret123' }));

    expect(error.status).toBe(400);
    expect(w.users.rows[0].isGuest).toBe(true); // nothing happened, the code is still valid

    // the person holding the phone chooses their own address: the typed one is gone
    await w.service.activateGuestAccount({ phone: '55 111 222', otp: code, password: 'Secret123', email: 'mine@mail.tn' });

    const row = w.users.rows.find((u) => u.id === guest.id)!;
    expect(row.email).toBe('mine@mail.tn');
    expect(row.emailVerifiedAt).toBe(null);
    expect(w.users.rows.some((u) => u.email === 'typed-by-someone-else@mail.tn')).toBe(false);
  });

  it('the link vouches for the mailbox it was sent to: another address needs the e-mail change', async () => {
    const w = await makeWorld();
    const { guest } = await guestWithOtp(w);
    const token = tokenIn(w.sentEmails[0].body);

    const error = await failure(w.service.activateGuestAccount({ token, password: 'Secret123', email: 'other@mail.tn' }));

    expect(error.status).toBe(400);
    expect(w.users.rows.find((u) => u.id === guest.id)!.isGuest).toBe(true); // the link was not used up

    await w.service.activateGuestAccount({ token, password: 'Secret123', email: 'SAMI@mail.tn' });
    expect(w.users.rows.find((u) => u.id === guest.id)!.isGuest).toBe(false);
  });

  it('a link never opens a profile whose address was made up', async () => {
    const w = await makeWorld();
    const guest = w.users.insert({ email: 'guest_123456@smart-depannage.com', password: w.password, isGuest: true, phone: '55 111 222', phoneKey: '+21655111222' });
    const raw = 'abc123';

    w.authToken.insert({
      userId: guest.id,
      type: 'GUEST_MAGIC_LINK',
      tokenHash: createHash('sha256').update(raw).digest('hex'),
      expiresAt: new Date(Date.now() + 60_000),
    });

    expect((await failure(w.service.activateGuestAccount({ token: raw, password: 'Secret123' }))).status).toBe(400);
    expect(w.users.rows[0].isGuest).toBe(true);
  });

  it('somebody who files a request with ANOTHER person\'s address and their own phone gets that phone proven, not the address', async () => {
    const w = await makeWorld();
    w.users.insert({ email: 'victim@mail.tn', password: w.password, isGuest: true, phone: '55 111 222', phoneKey: '+21655111222' });
    await w.service.requestAccountActivation({ phone: '55 111 222' });
    const code = codeIn(w.sentSms[0].body);

    // the attacker holds the phone; the victim's mailbox got a link they cannot read
    await w.service.activateGuestAccount({ phone: '55 111 222', otp: code, password: 'Attacker123', email: 'attacker@mail.tn' });

    const row = w.users.rows[0];
    expect(row.email).toBe('attacker@mail.tn');
    expect(row.email).not.toBe('victim@mail.tn');
    expect(row.emailVerifiedAt).toBe(null);
  });

  it('a profile made from a phone number must give an address to log in with', async () => {
    const w = await makeWorld();
    const guest = w.users.insert({ email: GENERATED, password: w.password, isGuest: true, phone: '55 111 222', phoneKey: '+21655111222' });

    await w.service.requestAccountActivation({ phone: '55 111 222' });
    const code = codeIn(w.sentSms[0].body);

    expect((await failure(w.service.activateGuestAccount({ phone: '55 111 222', otp: code, password: 'Secret123' }))).status).toBe(400);
    expect((await failure(w.service.activateGuestAccount({ phone: '55 111 222', otp: code, password: 'Secret123', email: 'x@guest.smart-depannage.local' }))).status).toBe(400);

    w.users.insert({ email: 'taken@mail.tn', password: w.password });
    expect((await failure(w.service.activateGuestAccount({ phone: '55 111 222', otp: code, password: 'Secret123', email: 'taken@mail.tn' }))).status).toBe(400);

    await w.service.activateGuestAccount({ phone: '55 111 222', otp: code, password: 'Secret123', email: 'Sami@Mail.tn' });

    const row = w.users.rows.find((u) => u.id === guest.id)!;
    expect(row.email).toBe('sami@mail.tn');
    expect(row.emailVerifiedAt).toBe(null); // not proven yet
    expect(row.isGuest).toBe(false);
  });

  it('five wrong codes lock the number, whichever way it is written', async () => {
    const w = await makeWorld();
    const { code } = await guestWithOtp(w);
    const wrong = code === '000000' ? '111111' : '000000';
    const spellings = ['55 111 222', '+21655111222', '0021655111222', '55111222', '+216 55 111 222'];

    for (const phone of spellings) {
      expect((await failure(w.service.activateGuestAccount({ phone, otp: wrong, password: 'Secret123' }))).status).toBe(400);
    }

    // locked: even the right code is refused now
    expect((await failure(w.service.activateGuestAccount({ phone: '55 111 222', otp: code, password: 'Secret123' }))).status).toBe(429);
  });

  it('a number nobody has is counted like any other wrong code', async () => {
    const w = await makeWorld();

    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await failure(w.service.activateGuestAccount({ phone: '99 000 111', otp: '123456', password: 'Secret123' }))).status).toBe(400);
    }

    expect((await failure(w.service.activateGuestAccount({ phone: '99 000 111', otp: '123456', password: 'Secret123' }))).status).toBe(429);
  });

  it('a code made for one guest does not open another', async () => {
    const w = await makeWorld();
    const { code } = await guestWithOtp(w);
    const second = w.users.insert({ email: 'second@mail.tn', password: w.password, isGuest: true, phone: '55 333 444', phoneKey: '+21655333444' });

    expect((await failure(w.service.activateGuestAccount({ phone: '55 333 444', otp: code, password: 'Secret123' }))).status).toBe(400);
    expect(w.users.rows.find((u) => u.id === second.id)!.isGuest).toBe(true);
  });
});

describe('activateGuestAccount: guessing and blanks', () => {
  it('guesses sent at the same moment are counted too: at most five get an answer', async () => {
    const w = await makeWorld();
    w.users.insert({ email: 'sami@mail.tn', password: w.password, isGuest: true, phone: '55 111 222', phoneKey: '+21655111222' });
    await w.service.requestAccountActivation({ phone: '55 111 222' });
    const right = codeIn(w.sentSms[0].body);
    const wrong = right === '000000' ? '111111' : '000000';

    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        w.service.activateGuestAccount({ phone: '55 111 222', otp: wrong, password: 'Secret123', email: 'sami@mail.tn' }),
      ),
    );

    const statuses = results.map((r) => (r.status === 'rejected' ? (r.reason as any).status : 200));

    expect(statuses.filter((status) => status === 400).length).toBe(5);
    expect(statuses.filter((status) => status === 429).length).toBe(7);
    expect((await failure(w.service.activateGuestAccount({ phone: '55 111 222', otp: right, password: 'Secret123', email: 'sami@mail.tn' }))).status).toBe(429);
  });

  it('a blank phone is not a lookup: it matches no guest, with or without a number on the profile', async () => {
    const w = await makeWorld();
    w.users.insert({ email: 'nophone@mail.tn', password: w.password, isGuest: true });
    w.users.insert({ email: 'sami@mail.tn', password: w.password, isGuest: true, phone: '55 111 222', phoneKey: '+21655111222' });

    for (const phone of ['', '   ']) {
      expect((await failure(w.service.activateGuestAccount({ phone, otp: '123456', password: 'Secret123', email: 'x@mail.tn' }))).status).toBe(400);
    }

    expect(w.users.rows.every((u) => u.isGuest)).toBe(true);
  });

  it('a code that was made for another purpose does not activate: the hash carries the purpose', async () => {
    const w = await makeWorld();
    const guest = w.users.insert({ email: 'sami@mail.tn', password: w.password, isGuest: true, phone: '55 111 222', phoneKey: '+21655111222' });

    // a phone-verification code (same 6 digits, same user) stored as such
    w.authToken.insert({
      userId: guest.id,
      type: 'GUEST_OTP',
      tokenHash: hashOneTimeCode(guest.id, 'phone-verification', '123456'),
      expiresAt: new Date(Date.now() + 60_000),
    });

    expect((await failure(w.service.activateGuestAccount({ phone: '55 111 222', otp: '123456', password: 'Secret123', email: 'sami@mail.tn' }))).status).toBe(400);
    expect(w.users.rows[0].isGuest).toBe(true);
  });
});

describe('a guest profile is reused only when it agrees with the whole form (review, pass 2)', () => {
  const profile = (w: Awaited<ReturnType<typeof makeWorld>>, extra: Record<string, unknown>) =>
    w.users.insert({ password: w.password, isGuest: true, ...extra });

  it('somebody seeded a profile with the victim\'s number and their own address: the victim\'s request does not join it', async () => {
    const w = await makeWorld();
    const seeded = profile(w, { email: 'attacker@mail.tn', phone: '55 111 222', phoneKey: '+21655111222' });

    const mine = await (w.service as any).findOrCreateGuestProfile(request('55 111 222', { contactEmail: 'victim@mail.tn' }));

    expect(mine.id).not.toBe(seeded.id);
    expect(mine.email).toBe('victim@mail.tn');
    expect(mine.phone).toBe(null); // the number is held by the other profile; the request carries it
    expect(w.users.rows.length).toBe(2);
  });

  it('a phone-only form is not attached to a profile that has a mailbox behind it', async () => {
    const w = await makeWorld();
    const seeded = profile(w, { email: 'attacker@mail.tn', phone: '55 111 222', phoneKey: '+21655111222' });

    const mine = await (w.service as any).findOrCreateGuestProfile(request('55 111 222'));

    expect(mine.id).not.toBe(seeded.id);
    expect(mine.email.endsWith('@guest.smart-depannage.local')).toBe(true);
  });

  it('somebody seeded a profile with the victim\'s ADDRESS and their own number: the victim\'s notices do not go to that number', async () => {
    const w = await makeWorld();
    const seeded = profile(w, { email: 'victim@mail.tn', phone: '99 000 111', phoneKey: '+21699000111' });

    const mine = await (w.service as any).findOrCreateGuestProfile(request('55 111 222', { contactEmail: 'victim@mail.tn' }));

    expect(mine.id).not.toBe(seeded.id);
    expect(mine.phoneKey).toBe('+21655111222');
    expect(mine.email.endsWith('@guest.smart-depannage.local')).toBe(true); // the address is the other profile\'s
    expect(w.users.rows.find((u) => u.id === seeded.id)!.phone).toBe('99 000 111');
  });

  it('a form with only the address is not attached to a profile that has a number of its own', async () => {
    const w = await makeWorld();
    const seeded = profile(w, { email: 'victim@mail.tn', phone: '99 000 111', phoneKey: '+21699000111' });

    const mine = await (w.service as any).findOrCreateGuestProfile({ contactEmail: 'victim@mail.tn', serviceType: 'PLOMBIER', description: 'x', address: 'Tunis' } as any);

    expect(mine.id).not.toBe(seeded.id);
  });

  it('the same person coming back with the same details, or with a profile that has no mailbox, is the same profile', async () => {
    const w = await makeWorld();
    const first = await (w.service as any).findOrCreateGuestProfile(request('55 111 222', { contactEmail: 'sami@mail.tn' }));
    const again = await (w.service as any).findOrCreateGuestProfile(request('+216 55 111 222', { contactEmail: 'Sami@Mail.tn' }));

    expect(again.id).toBe(first.id);

    // a profile made from a phone number alone has no mailbox: a later form with an address joins it
    const bare = await (w.service as any).findOrCreateGuestProfile(request('55 333 444'));
    const withAddress = await (w.service as any).findOrCreateGuestProfile(request('55 333 444', { contactEmail: 'other@mail.tn' }));

    expect(withAddress.id).toBe(bare.id);
  });
});

describe('activating through the link does not keep a number nobody proved (review, pass 2)', () => {
  it('the profile (victim address, attacker number) activated by the victim ends WITHOUT that number', async () => {
    const w = await makeWorld();
    const guest = w.users.insert({ email: 'victim@mail.tn', password: w.password, isGuest: true, phone: '99 000 111', phoneKey: '+21699000111' });

    await w.service.requestAccountActivation({ email: 'victim@mail.tn' });
    await w.service.activateGuestAccount({ token: tokenIn(w.sentEmails[0].body), password: 'Secret123' });

    const row = w.users.rows.find((u) => u.id === guest.id)!;
    expect(row.isGuest).toBe(false);
    expect(row.emailVerifiedAt instanceof Date).toBe(true);
    expect(row.phone).toBe(null);
    expect(row.phoneKey).toBe(null);
    expect(row.phoneVerifiedAt).toBe(null);
  });

  it('the code from the SMS proves the number, so that activation keeps it', async () => {
    const w = await makeWorld();
    const guest = w.users.insert({ email: 'sami@mail.tn', password: w.password, isGuest: true, phone: '55 111 222', phoneKey: '+21655111222' });

    await w.service.requestAccountActivation({ phone: '55 111 222' });
    await w.service.activateGuestAccount({ phone: '55 111 222', otp: codeIn(w.sentSms[0].body), password: 'Secret123', email: 'sami@mail.tn' });

    const row = w.users.rows.find((u) => u.id === guest.id)!;
    expect(row.phoneKey).toBe('+21655111222');
    expect(row.phoneVerifiedAt instanceof Date).toBe(true);
  });
});

describe('activation messages: one visitor cannot use up what the owner may receive (review, pass 2)', () => {
  it('a visitor over their own limit is stopped without touching the number\'s quota', async () => {
    const w = await makeWorld();
    w.users.insert({ email: GENERATED, password: w.password, isGuest: true, phone: '55 111 222', phoneKey: '+21655111222' });

    // the troublemaker asks ten times; only three go out, and they only count three
    for (let attempt = 0; attempt < 10; attempt++) {
      await w.service.requestAccountActivation({ phone: '55 111 222' }, '10.0.0.1');
    }

    expect(w.sentSms.length).toBe(3);

    // the real owner, from elsewhere, still gets a code
    await w.service.requestAccountActivation({ phone: '55 111 222' }, '10.0.0.2');
    expect(w.sentSms.length).toBe(4);
  });

  it('the number itself still has a ceiling of ten messages an hour, whoever asks', async () => {
    const w = await makeWorld();
    w.users.insert({ email: GENERATED, password: w.password, isGuest: true, phone: '55 111 222', phoneKey: '+21655111222' });

    for (let visitor = 1; visitor <= 5; visitor++) {
      for (let attempt = 0; attempt < 3; attempt++) {
        await w.service.requestAccountActivation({ phone: '55 111 222' }, `10.0.0.${visitor}`);
      }
    }

    expect(w.sentSms.length).toBe(10);
  });
});
