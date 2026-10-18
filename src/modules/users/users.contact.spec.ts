import * as argon2 from 'argon2';
import { createHash } from 'crypto';

import { FakeTable, withTransactions } from '../../common/testing/fake-tables';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { AuthService, GUEST_PROFILE_EXISTS } from '../auth/auth.service';
import { ContactChangeService } from './contact-change.service';
import { UsersService } from './users.service';

process.env.FRONTEND_URL = 'https://app.example.tn';
process.env.JWT_ACCESS_SECRET = 'a'.repeat(40);
process.env.JWT_REFRESH_SECRET = 'b'.repeat(40);

async function makeWorld() {
  const users = new FakeTable({
    unique: ['email', 'phoneKey'],
    defaults: () => ({
      name: 'Amel',
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
  const authToken = new FakeTable({
    unique: ['tokenHash'],
    defaults: () => ({ usedAt: null, revokedAt: null, newValue: null }),
    include: { user: (row) => users.rows.find((user) => user.id === row.userId) },
  });
  const profiles = new FakeTable({ unique: ['userId'] });
  const prisma: any = withTransactions({ user: users, authToken, artisanProfile: profiles }, [users, authToken, profiles]);

  const sentEmails: any[] = [];
  const notifications: any = {
    sendEmail: async (to: string, subject: string, body: string, options: any) => {
      sentEmails.push({ to, subject, body, options });
      return { queued: true };
    },
    sendSms: async () => ({ queued: true }),
    isEmailSimulated: () => false,
    isSmsSimulated: () => false,
  };

  const rateLimit = new RateLimitService();
  const contactChange = new ContactChangeService(prisma, notifications, rateLimit);
  const usersService = new UsersService(prisma, notifications, contactChange);
  let signed = 0;
  const jwt: any = { signAsync: async () => `jwt-${++signed}` };
  const auth = new AuthService(usersService, jwt, prisma, notifications, rateLimit);
  const password = await argon2.hash('Secret123');

  const amel = users.insert({ email: 'amel@mail.tn', password, phone: '22 123 456', phoneKey: '+21622123456', emailVerifiedAt: new Date(), phoneVerifiedAt: new Date() });
  const other = users.insert({ email: 'other@mail.tn', password, phone: '98 765 432', phoneKey: '+21698765432' });

  return { users, authToken, profiles, usersService, auth, sentEmails, amel, other, password, contactChange };
}

async function failure(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('expected a failure');
}

describe('PATCH /users/me (updateProfile)', () => {
  it('no longer changes the e-mail address: 400 with a code the apps can read', async () => {
    const w = await makeWorld();

    const error = await failure(w.usersService.updateProfile(w.amel.id, { email: 'new@mail.tn' }));

    expect(error.status).toBe(400);
    expect(error.getResponse().code).toBe('CONTACT_CHANGE_REQUIRES_VERIFICATION');
    expect(error.getResponse().field).toBe('email');
    expect(w.users.rows.find((u) => u.id === w.amel.id)!.email).toBe('amel@mail.tn');
  });

  it('no longer changes the phone number either, even from nothing to a number', async () => {
    const w = await makeWorld();
    const bare = w.users.insert({ email: 'bare@mail.tn', password: w.password });

    const changed = await failure(w.usersService.updateProfile(w.amel.id, { phone: '55 111 222' }));
    const added = await failure(w.usersService.updateProfile(bare.id, { phone: '55 111 222' }));

    expect(changed.getResponse().field).toBe('phone');
    expect(added.getResponse().field).toBe('phone');
    expect(w.users.rows.find((u) => u.id === w.amel.id)!.phone).toBe('22 123 456');
    expect(w.users.rows.find((u) => u.id === bare.id)!.phone).toBe(null);
  });

  it('accepts the values the account already has (an app posting the whole form)', async () => {
    const w = await makeWorld();

    const updated = await w.usersService.updateProfile(w.amel.id, {
      name: 'Amel B',
      email: ' AMEL@mail.tn ',
      phone: '+216 22 123 456',
      address: 'Tunis',
    });

    expect(updated.name).toBe('Amel B');
    expect(updated.address).toBe('Tunis');

    const row = w.users.rows.find((u) => u.id === w.amel.id)!;
    expect(row.email).toBe('amel@mail.tn');
    expect(row.phone).toBe('22 123 456'); // untouched, still verified
    expect(row.phoneVerifiedAt instanceof Date).toBe(true);
    expect(row.emailVerifiedAt instanceof Date).toBe(true);
  });

  it('removing the number is a contact change too: refused while the account has one, nothing to do when it has none', async () => {
    const w = await makeWorld();
    const bare = w.users.insert({ email: 'bare@mail.tn', password: w.password });

    const error = await failure(w.usersService.updateProfile(w.amel.id, { phone: '' }));

    expect(error.getResponse().code).toBe('CONTACT_CHANGE_REQUIRES_VERIFICATION');
    expect(error.getResponse().field).toBe('phone');

    const row = w.users.rows.find((u) => u.id === w.amel.id)!;
    expect(row.phone).toBe('22 123 456');
    expect(row.phoneKey).toBe('+21622123456');
    expect(row.phoneVerifiedAt instanceof Date).toBe(true);

    // an app that posts an empty field for an account without a number is not asking for a change
    await w.usersService.updateProfile(bare.id, { phone: '', name: 'Bare' });
    expect(w.users.rows.find((u) => u.id === bare.id)!.name).toBe('Bare');
  });
});

describe('PATCH /users/:id (updateByAdmin)', () => {
  it('staff can correct another account: unique, unverified, old mailbox told', async () => {
    const w = await makeWorld();

    const updated = await w.usersService.updateByAdmin(
      w.amel.id,
      { email: 'fixed@mail.tn', phone: '55 111 222', name: 'Amel C' },
      { actorId: 999 },
    );

    expect(updated.email).toBe('fixed@mail.tn');
    expect(updated.name).toBe('Amel C');

    const row = w.users.rows.find((u) => u.id === w.amel.id)!;
    expect(row.phoneKey).toBe('+21655111222');
    expect(row.emailVerifiedAt).toBe(null);
    expect(row.phoneVerifiedAt).toBe(null);

    // the OLD mailbox is told the e-mail changed; the phone notice goes to the address the account has now
    expect(w.sentEmails.map((mail) => [mail.to, mail.options.template.key])).toEqual([
      ['amel@mail.tn', 'auth.email_changed_notice'],
      ['fixed@mail.tn', 'auth.phone_changed_notice'],
    ]);
  });

  it('staff can correct a deleted account (to free a number, say) and its pending guest links die', async () => {
    const w = await makeWorld();
    const gone = w.users.insert({ email: 'gone@mail.tn', password: w.password, isActive: false, deletedAt: new Date(), phone: '55 111 222', phoneKey: null });

    await w.authToken.create({ data: { userId: gone.id, type: 'GUEST_MAGIC_LINK', tokenHash: 'link-hash', expiresAt: new Date(Date.now() + 1e6) } });
    await w.authToken.create({ data: { userId: gone.id, type: 'GUEST_OTP', tokenHash: 'otp-hash', expiresAt: new Date(Date.now() + 1e6) } });

    await w.usersService.updateByAdmin(gone.id, { email: 'gone2@mail.tn', phone: '55 333 444' }, { actorId: 999 });

    const row = w.users.rows.find((u) => u.id === gone.id)!;
    expect(row.email).toBe('gone2@mail.tn');
    expect(row.phone).toBe('55 333 444');
    expect(w.authToken.rows.filter((t) => t.userId === gone.id).every((t) => t.revokedAt instanceof Date)).toBe(true);
  });

  it('the change and the end of the old links are one step: if revoking fails, nothing changed', async () => {
    const w = await makeWorld();
    await w.authToken.create({ data: { userId: w.amel.id, type: 'PASSWORD_RESET', tokenHash: 'reset-hash', expiresAt: new Date(Date.now() + 1e6) } });

    const realUpdateMany = w.authToken.updateMany.bind(w.authToken);
    w.authToken.updateMany = async () => {
      throw new Error('database hiccup');
    };

    await failure(w.usersService.updateByAdmin(w.amel.id, { email: 'fixed@mail.tn' }, { actorId: 999 }));
    w.authToken.updateMany = realUpdateMany;

    expect(w.users.rows.find((u) => u.id === w.amel.id)!.email).toBe('amel@mail.tn');
    expect(w.authToken.rows.find((t) => t.tokenHash === 'reset-hash')!.revokedAt).toBe(null);
    expect(w.sentEmails.length).toBe(0); // and nobody was told about a change that did not happen
  });

  it('refuses a number or an address that belongs to another account', async () => {
    const w = await makeWorld();

    expect((await failure(w.usersService.updateByAdmin(w.amel.id, { phone: '+216 98 765 432' }, { actorId: 999 }))).status).toBe(409);
    expect((await failure(w.usersService.updateByAdmin(w.amel.id, { email: 'Other@mail.tn' }, { actorId: 999 }))).status).toBe(409);
  });

  it('an admin editing their OWN contact details is sent to the password-checked route', async () => {
    const w = await makeWorld();

    const error = await failure(w.usersService.updateByAdmin(w.amel.id, { email: 'mine@mail.tn' }, { actorId: w.amel.id }));

    expect(error.getResponse().code).toBe('CONTACT_CHANGE_REQUIRES_VERIFICATION');
    expect(w.users.rows.find((u) => u.id === w.amel.id)!.email).toBe('amel@mail.tn');

    // but their name or role stay editable
    const ok = await w.usersService.updateByAdmin(w.amel.id, { name: 'Boss' }, { actorId: w.amel.id });
    expect(ok.name).toBe('Boss');
  });
});

describe('creating accounts: one number, one account', () => {
  it('create() stores the number and its key, and refuses a number already used', async () => {
    const w = await makeWorld();

    const created = await w.usersService.create({ email: 'New@Mail.tn', password: 'Secret123', phone: '55 111 222' } as any);

    expect(created.email).toBe('new@mail.tn');
    expect(created.phoneKey).toBe('+21655111222');

    const taken = await failure(w.usersService.create({ email: 'b@mail.tn', password: 'Secret123', phone: '0021655111222' } as any));
    expect(taken.status).toBe(409);

    const invalid = await failure(w.usersService.create({ email: 'c@mail.tn', password: 'Secret123', phone: 'abc' } as any));
    expect(invalid.status).toBe(400);
  });

  it('turns the database\'s unique violation into a 409 when two sign-ups race', async () => {
    const w = await makeWorld();

    // the pre-check sees nobody, the insert then loses the race
    const original = w.users.findFirst;
    w.users.findFirst = async () => null;
    w.users.insert({ email: 'racer@mail.tn', password: w.password, phone: '55 111 222', phoneKey: '+21655111222' });

    const error = await failure(w.usersService.create({ email: 'late@mail.tn', password: 'Secret123', phone: '55 111 222' } as any));
    w.users.findFirst = original;

    expect(error.status).toBe(409);
  });

  it('a staff member whose number is taken is refused with a 409', async () => {
    const w = await makeWorld();
    (w.usersService as any).sendPasswordSetupLink = async () => undefined;

    const staff = await failure(w.usersService.createStaffUser({ name: 'Sami', email: 'sami@mail.tn', phone: '22123456', role: 'SUPPORT' as any }));
    expect(staff.status).toBe(409);
  });
});

describe('POST /auth/register', () => {
  it('a number already used by a real account is refused, whatever the spelling', async () => {
    const w = await makeWorld();

    const error = await failure(w.auth.register({ email: 'new@mail.tn', password: 'Secret123', phone: '+216 22 123 456' }));

    expect(error.status).toBe(409);
    expect(error.message).toBe('Ce numéro de téléphone est déjà utilisé.');
  });

  it('a guest profile with the same e-mail OR the same number is not taken over: 409 with a code', async () => {
    const w = await makeWorld();
    w.users.insert({ email: 'guest@mail.tn', password: w.password, isGuest: true, phone: '55 111 222', phoneKey: '+21655111222' });

    const byEmail = await failure(w.auth.register({ email: 'Guest@Mail.tn', password: 'Secret123', phone: '55 999 000' }));
    const byPhone = await failure(w.auth.register({ email: 'fresh@mail.tn', password: 'Secret123', phone: '+216 55 111 222' }));

    for (const error of [byEmail, byPhone]) {
      expect(error.status).toBe(409);
      expect(error.getResponse().code).toBe(GUEST_PROFILE_EXISTS);
    }

    // nothing was converted and nothing was created
    expect(w.users.rows.filter((u) => u.isGuest).length).toBe(1);
    expect(w.users.rows.length).toBe(3);
  });

  it('a new person registers, with the number stored in both columns', async () => {
    const w = await makeWorld();

    const result = await w.auth.register({ email: 'fresh@mail.tn', password: 'Secret123', phone: '55 111 222' });

    expect(result.user.email).toBe('fresh@mail.tn');
    expect(w.users.rows.find((u) => u.email === 'fresh@mail.tn')!.phoneKey).toBe('+21655111222');
  });

  it('a number that cannot be a phone number is a 400', async () => {
    const w = await makeWorld();

    expect((await failure(w.auth.register({ email: 'fresh@mail.tn', password: 'Secret123', phone: 'call me' }))).status).toBe(400);
  });
});

describe('deleting and bringing back an account: the number is not held by the dead', () => {
  it('a deleted account gives its number up: someone else can register with it, whatever the spelling', async () => {
    const w = await makeWorld();

    await w.usersService.deactivateAccount(w.amel.id);

    const row = w.users.rows.find((u) => u.id === w.amel.id)!;
    expect(row.phone).toBe('22 123 456'); // the text stays for the records
    expect(row.phoneKey).toBe(null);

    // the same text, then another spelling: both are free
    await w.auth.register({ email: 'new1@mail.tn', password: 'Secret123', phone: '22 123 456' });
    expect(w.users.rows.find((u) => u.email === 'new1@mail.tn')!.phoneKey).toBe('+21622123456');
    expect((await failure(w.auth.register({ email: 'new2@mail.tn', password: 'Secret123', phone: '+216 22123456' }))).status).toBe(409);
  });

  it('bringing the account back takes the number again only if nobody has it', async () => {
    const w = await makeWorld();

    await w.usersService.deactivateAccount(w.amel.id);
    await w.usersService.reactivateUser(w.amel.id);
    expect(w.users.rows.find((u) => u.id === w.amel.id)!.phoneKey).toBe('+21622123456');

    await w.usersService.deactivateAccount(w.amel.id);
    await w.auth.register({ email: 'new@mail.tn', password: 'Secret123', phone: '22123456' });
    await w.usersService.reactivateUser(w.amel.id);

    const row = w.users.rows.find((u) => u.id === w.amel.id)!;
    expect(row.isActive).toBe(true);
    expect(row.phoneKey).toBe(null); // comes back without the key; staff sort the number out
    expect(w.users.rows.filter((u) => u.phoneKey === '+21622123456').length).toBe(1);
  });

  it('a deleted guest does not hold the number or the e-mail against a new sign-up', async () => {
    const w = await makeWorld();
    w.users.insert({ email: 'guest_9@guest.smart-depannage.local', password: w.password, isGuest: true, isActive: false, deletedAt: new Date(), phone: '55 111 222', phoneKey: null });

    const result = await w.auth.register({ email: 'fresh@mail.tn', password: 'Secret123', phone: '55 111 222' });

    expect(result.user.email).toBe('fresh@mail.tn');
    expect(w.users.rows.find((u) => u.email === 'fresh@mail.tn')!.phoneKey).toBe('+21655111222');
  });
});

describe('a pending contact change does not survive the owner taking the account back', () => {
  async function pending(w: Awaited<ReturnType<typeof makeWorld>>) {
    await w.contactChange.requestEmailChange(w.amel.id, { newEmail: 'thief@mail.tn', currentPassword: 'Secret123' });
    await w.contactChange.requestPhoneChange(w.amel.id, { newPhone: '55 111 222', currentPassword: 'Secret123' });

    return w.authToken.rows.filter((t) => ['EMAIL_CHANGE', 'PHONE_CHANGE'].includes(t.type) && !t.revokedAt).length;
  }

  it('changing the password revokes them', async () => {
    const w = await makeWorld();

    expect(await pending(w)).toBe(2);
    await w.auth.changePassword(w.amel.id, 'Secret123', 'Another456');

    expect(w.authToken.rows.filter((t) => ['EMAIL_CHANGE', 'PHONE_CHANGE'].includes(t.type) && !t.revokedAt).length).toBe(0);
  });

  it('a password reset revokes them', async () => {
    const w = await makeWorld();

    expect(await pending(w)).toBe(2);

    w.authToken.insert({
      userId: w.amel.id,
      type: 'PASSWORD_RESET',
      tokenHash: createHash('sha256').update('reset-token').digest('hex'),
      expiresAt: new Date(Date.now() + 60_000),
    });
    await w.auth.resetPassword('reset-token', 'Another456');

    expect(w.authToken.rows.filter((t) => ['EMAIL_CHANGE', 'PHONE_CHANGE'].includes(t.type) && !t.revokedAt).length).toBe(0);
  });

  it('signing out of every device revokes them', async () => {
    const w = await makeWorld();

    expect(await pending(w)).toBe(2);
    await w.auth.logoutEverywhere(w.amel.id);

    expect(w.authToken.rows.filter((t) => ['EMAIL_CHANGE', 'PHONE_CHANGE'].includes(t.type) && !t.revokedAt).length).toBe(0);
  });
});
