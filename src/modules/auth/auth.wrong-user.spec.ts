import { createHash } from 'crypto';

import * as argon2 from 'argon2';

import { MemoryPrisma } from '../../common/testing/memory-prisma';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { getJwtRefreshSecret } from '../../config/env';
import { ContactChangeService } from '../users/contact-change.service';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';

process.env.FRONTEND_URL = 'https://app.example.tn';
process.env.JWT_ACCESS_SECRET = 'a'.repeat(40);
process.env.JWT_REFRESH_SECRET = 'b'.repeat(40);

/**
 * The routes of /auth when the person is the wrong one (P1-17): a wrong password, another person's password, a token
 * that is somebody else's, a link that was meant for another account. They are the real AuthService and UsersService
 * on the in-memory database, with two people, Alice and Bob. What leaves (the e-mails and the texts) is written down.
 */
const ALICE = 'AliceSecret123';
const BOB = 'BobSecret45678';
const hashes = Promise.all([argon2.hash(ALICE), argon2.hash(BOB)]);

/** A token signer that checks what it is given: a token signed with one secret is not read with the other. */
function fakeJwt() {
  let counter = 0;

  return {
    signAsync: async (payload: any, options: { secret: string }) =>
      `${options.secret}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${++counter}`,
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
  const [aliceHash, bobHash] = await hashes;
  const alice = memory.plant('user', { email: 'alice@mail.tn', password: aliceHash, name: 'Alice', role: 'CLIENT', isActive: true, isGuest: false, phone: '22 123 456', phoneKey: '+21622123456' });
  const bob = memory.plant('user', { email: 'bob@mail.tn', password: bobHash, name: 'Bob', role: 'CLIENT', isActive: true, isGuest: false, phone: '98 765 432', phoneKey: '+21698765432' });

  const sent: Array<{ kind: 'email' | 'sms'; to: string; body: string }> = [];
  const notifications: any = {
    sendEmail: async (to: string, _subject: string, body: string) => {
      sent.push({ kind: 'email', to, body });

      return { queued: true };
    },
    sendSms: async (to: string, body: string) => {
      sent.push({ kind: 'sms', to, body });

      return { queued: true };
    },
    isEmailSimulated: () => false,
    isSmsSimulated: () => false,
  };

  const rateLimit = new RateLimitService();
  const contactChange = new ContactChangeService(prisma, notifications, rateLimit);
  const usersService = new UsersService(prisma, notifications, contactChange);
  const jwt = fakeJwt();
  const auth = new AuthService(usersService, jwt as any, prisma, notifications, rateLimit);

  return { memory, prisma, auth, usersService, contactChange, alice, bob, aliceHash, bobHash, sent, jwt };
}

async function failure(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('expected a failure');
}

const row = (w: { memory: MemoryPrisma }, model: string, id: number) => w.memory.rows(model).find((entry) => entry.id === id) as any;
const tokenIn = (body: string) => /token=([A-Za-z0-9_-]+)/.exec(body)![1];

describe('POST /auth/login with the wrong person (P1-17)', () => {
  it('opens the account of the person who knows the password, and answers without the hash', async () => {
    const w = await makeWorld();
    const answer: any = await w.auth.login('alice@mail.tn', ALICE, '10.0.0.1');

    expect(answer.user.id).toBe(w.alice.id);
    expect(answer.user).not.toHaveProperty('password');
    expect(JSON.stringify(answer)).not.toContain(w.aliceHash);
    expect(answer.accessToken).toBeTruthy();
    expect(answer.refreshToken).toBeTruthy();
  });

  it('a wrong password, somebody else\'s password and an e-mail nobody has are refused alike: nothing tells which was wrong', async () => {
    const w = await makeWorld();
    const wrong = await failure(w.auth.login('alice@mail.tn', 'not-the-password', '10.0.0.1'));
    const others = await failure(w.auth.login('alice@mail.tn', BOB, '10.0.0.1'));
    const nobody = await failure(w.auth.login('nobody@mail.tn', ALICE, '10.0.0.1'));

    for (const error of [wrong, others, nobody]) {
      expect(error.getStatus()).toBe(401);
      expect(error.message).toBe('Email ou mot de passe incorrect.');
    }

    expect(w.memory.rows('authToken')).toHaveLength(0);
  });

  it('the state of an account (closed, a guest profile) is told only to somebody who knows its password', async () => {
    const w = await makeWorld();

    row(w, 'user', w.alice.id).isActive = false;

    const knows = await failure(w.auth.login('alice@mail.tn', ALICE, '10.0.0.1'));
    const guesses = await failure(w.auth.login('alice@mail.tn', 'not-the-password', '10.0.0.2'));

    expect(knows.message).toBe('Compte désactivé.');
    expect(guesses.message).toBe('Email ou mot de passe incorrect.');

    row(w, 'user', w.alice.id).isActive = true;
    row(w, 'user', w.alice.id).isGuest = true;

    expect((await failure(w.auth.login('alice@mail.tn', ALICE, '10.0.0.3'))).getStatus()).toBe(401);
    expect(w.memory.rows('authToken')).toHaveLength(0);
  });
});

describe('POST /auth/refresh with the wrong person (P1-17)', () => {
  it('gives a new pair to the owner of the token, once: the token is spent', async () => {
    const w = await makeWorld();
    const first: any = await w.auth.login('alice@mail.tn', ALICE, '10.0.0.1');
    const second: any = await w.auth.refresh(first.refreshToken);

    expect(second.user.id).toBe(w.alice.id);
    expect(second.user).not.toHaveProperty('password');
    expect((await failure(w.auth.refresh(first.refreshToken))).getStatus()).toBe(401);
  });

  it('a token that says it is Alice\'s and points at Bob\'s session is refused, and the other way round', async () => {
    const w = await makeWorld();

    await w.auth.login('alice@mail.tn', ALICE, '10.0.0.1');
    await w.auth.login('bob@mail.tn', BOB, '10.0.0.2');

    const [aliceSession, bobSession] = [w.alice.id, w.bob.id].map((id) => w.memory.rows('authToken').find((entry) => entry.userId === id) as any);
    const secret = getJwtRefreshSecret();
    const forgedForBob = await w.jwt.signAsync({ sub: w.alice.id, email: 'alice@mail.tn', role: 'CLIENT', tokenId: bobSession.id, tokenType: 'refresh' }, { secret });
    const forgedForAlice = await w.jwt.signAsync({ sub: w.bob.id, email: 'bob@mail.tn', role: 'CLIENT', tokenId: aliceSession.id, tokenType: 'refresh' }, { secret });

    expect((await failure(w.auth.refresh(forgedForBob))).getStatus()).toBe(401);
    expect((await failure(w.auth.refresh(forgedForAlice))).getStatus()).toBe(401);
    expect(bobSession.usedAt).toBeNull();
    expect(aliceSession.usedAt).toBeNull();
  });

  it('a signed token for the right session that is not the one that was handed out is refused', async () => {
    const w = await makeWorld();
    const pair: any = await w.auth.login('alice@mail.tn', ALICE, '10.0.0.1');
    const session = w.memory.rows('authToken').find((entry) => entry.userId === w.alice.id) as any;
    const another = await w.jwt.signAsync({ sub: w.alice.id, email: 'alice@mail.tn', role: 'CLIENT', tokenId: session.id, tokenType: 'refresh' }, { secret: getJwtRefreshSecret() });

    expect(another).not.toBe(pair.refreshToken);
    expect((await failure(w.auth.refresh(another))).getStatus()).toBe(401);
    expect(session.usedAt ?? null).toBeNull();
    expect((await w.auth.refresh(pair.refreshToken) as any).user.id).toBe(w.alice.id);
  });

  it('an access token, a made-up token and the token of a closed account are refused', async () => {
    const w = await makeWorld();
    const pair: any = await w.auth.login('alice@mail.tn', ALICE, '10.0.0.1');

    expect((await failure(w.auth.refresh(pair.accessToken))).getStatus()).toBe(401);
    expect((await failure(w.auth.refresh('made-up'))).getStatus()).toBe(401);
    expect((await failure(w.auth.refresh(undefined as any))).getStatus()).toBe(401);

    row(w, 'user', w.alice.id).isActive = false;

    expect((await failure(w.auth.refresh(pair.refreshToken))).getStatus()).toBe(401);
  });

  it('after a logout the token is spent', async () => {
    const w = await makeWorld();
    const pair: any = await w.auth.login('alice@mail.tn', ALICE, '10.0.0.1');

    await w.auth.logout(pair.refreshToken);

    expect((await failure(w.auth.refresh(pair.refreshToken))).getStatus()).toBe(401);
  });
});

describe('POST /auth/refresh: every check on the session behind the token (P1-17)', () => {
  /** A session row and a token that is signed for it, as the server would have made them; `patch` spoils one thing. */
  async function session(w: Awaited<ReturnType<typeof makeWorld>>, owner: { id?: unknown; email?: unknown }, patch: { row?: Record<string, unknown>; claims?: Record<string, unknown> } = {}) {
    const planted = w.memory.plant('authToken', { userId: owner.id, type: 'REFRESH', tokenHash: `placeholder-${w.memory.rows('authToken').length}`, expiresAt: new Date(Date.now() + 86_400_000), usedAt: null, revokedAt: null, ...patch.row }) as any;
    const record = row(w, 'authToken', planted.id);
    const token = await w.jwt.signAsync({ sub: owner.id, email: owner.email, role: 'CLIENT', tokenId: record.id, tokenType: 'refresh', ...patch.claims }, { secret: getJwtRefreshSecret() });

    record.tokenHash = createHash('sha256').update(token).digest('hex');

    return { token, record };
  }

  it('the control: a session that is right in every way gives a new pair, so the refusals below are because of the one thing spoiled', async () => {
    const w = await makeWorld();
    const { token } = await session(w, w.alice);

    expect(((await w.auth.refresh(token)) as any).user.id).toBe(w.alice.id);
  });

  it('a token that is signed with the right secret but says it is not a refresh token is refused, and the session is not spent', async () => {
    const w = await makeWorld();
    const { token, record } = await session(w, w.alice, { claims: { tokenType: 'access' } });

    expect((await failure(w.auth.refresh(token))).getStatus()).toBe(401);
    expect(record.usedAt).toBeNull();
  });

  it('a token for a session that does not exist is a 401, not a crash', async () => {
    const w = await makeWorld();
    const { token } = await session(w, w.alice, { claims: { tokenId: 99_999 } });
    const error = await failure(w.auth.refresh(token));

    expect(error.getStatus).toBeDefined();
    expect(error.getStatus()).toBe(401);
  });

  it('a row of another kind (a password link, a code) can never serve as a session, even when it holds the hash of the token', async () => {
    const w = await makeWorld();

    for (const type of ['PASSWORD_RESET', 'EMAIL_VERIFICATION', 'PHONE_VERIFICATION', 'GUEST_OTP']) {
      const { token, record } = await session(w, w.alice, { row: { type } });
      const error = await failure(w.auth.refresh(token));

      expect(error.getStatus()).toBe(401);
      expect(record.usedAt ?? null).toBeNull();
    }
  });

  it('a session that belongs to somebody else is refused even when the hash is the token\'s own', async () => {
    const w = await makeWorld();
    const { token, record } = await session(w, w.alice, { row: { userId: w.bob.id } });

    expect((await failure(w.auth.refresh(token))).getStatus()).toBe(401);
    expect(record.usedAt ?? null).toBeNull();
  });

  it('a session that was used, one that was revoked and one that has run out are each refused, and nothing is spent', async () => {
    const w = await makeWorld();
    const spoilt = [{ usedAt: new Date() }, { revokedAt: new Date() }, { expiresAt: new Date(Date.now() - 1000) }];

    for (const row of spoilt) {
      const { token, record } = await session(w, w.alice, { row });
      const before = JSON.stringify(record);
      const error = await failure(w.auth.refresh(token));

      expect(error.getStatus()).toBe(401);
      expect(JSON.stringify(record)).toBe(before);
    }

    expect(w.memory.rows('authToken').filter((entry) => entry.type === 'REFRESH')).toHaveLength(spoilt.length);
  });

  it('the profile of a guest cannot have a session, and a closed account cannot keep one', async () => {
    const w = await makeWorld();
    const guest = w.memory.plant('user', { email: 'guest@mail.tn', password: null, name: 'Guest', role: 'CLIENT', isActive: true, isGuest: true, phone: '55 111 222', phoneKey: '+21655111222' }) as any;
    const closed = w.memory.plant('user', { email: 'closed@mail.tn', password: null, name: 'Closed', role: 'CLIENT', isActive: true, isGuest: false, deletedAt: new Date(), phone: '55 333 444', phoneKey: '+21655333444' }) as any;

    for (const owner of [guest, closed]) {
      const { token, record } = await session(w, owner);

      expect((await failure(w.auth.refresh(token))).getStatus()).toBe(401);
      expect(record.usedAt ?? null).toBeNull();
    }
  });
});

describe('login with a user that is already known, and changing the password of a closed account (P1-17)', () => {
  it('a guest profile and a closed account are not given a pair of tokens', async () => {
    const w = await makeWorld();
    const guest = w.memory.plant('user', { email: 'guest@mail.tn', password: null, name: 'Guest', role: 'CLIENT', isActive: true, isGuest: true, phone: '55 111 222', phoneKey: '+21655111222' }) as any;
    const closed = w.memory.plant('user', { email: 'closed@mail.tn', password: null, name: 'Closed', role: 'CLIENT', isActive: false, isGuest: false, phone: '55 333 444', phoneKey: '+21655333444' }) as any;
    const deleted = w.memory.plant('user', { email: 'deleted@mail.tn', password: null, name: 'Deleted', role: 'CLIENT', isActive: true, isGuest: false, deletedAt: new Date(), phone: '55 555 666', phoneKey: '+21655555666' }) as any;

    for (const user of [guest, closed, deleted]) {
      expect((await failure(w.auth.login(user as any))).getStatus()).toBe(401);
    }

    expect(w.memory.rows('authToken').filter((entry) => entry.type === 'REFRESH')).toHaveLength(0);
  });

  it('a closed account cannot change its password even with the right one, and the hash does not move', async () => {
    const w = await makeWorld();

    row(w, 'user', w.alice.id).isActive = false;

    const error = await failure(w.auth.changePassword(w.alice.id, ALICE, 'NewSecret123456'));

    expect(error.getStatus()).toBe(401);
    expect(row(w, 'user', w.alice.id).password).toBe(w.aliceHash);
  });
});

describe('POST /auth/logout and /auth/logout-everywhere with the wrong person (P1-17)', () => {
  it('a made-up token changes nothing and says nothing', async () => {
    const w = await makeWorld();

    await w.auth.login('alice@mail.tn', ALICE, '10.0.0.1');

    const before = JSON.stringify(w.memory.snapshot());
    const answer: any = await w.auth.logout('made-up');

    expect(answer.message).toBe('Déconnexion réussie.');
    expect(JSON.stringify(w.memory.snapshot())).toBe(before);
  });

  it('ends the session of the token it was given, and no other: not the same person\'s other phone, nor anybody else\'s', async () => {
    const w = await makeWorld();
    const phone: any = await w.auth.login('alice@mail.tn', ALICE, '10.0.0.1');

    await w.auth.login('alice@mail.tn', ALICE, '10.0.0.1');
    await w.auth.login('bob@mail.tn', BOB, '10.0.0.2');
    await w.auth.logout(phone.refreshToken);

    const open = w.memory.rows('authToken').filter((entry) => entry.revokedAt === null).map((entry) => entry.userId);

    expect(open.sort()).toEqual([w.alice.id, w.bob.id]);
  });

  it('logging out everywhere ends the caller\'s sessions and nobody else\'s', async () => {
    const w = await makeWorld();

    await w.auth.login('alice@mail.tn', ALICE, '10.0.0.1');
    await w.auth.login('alice@mail.tn', ALICE, '10.0.0.1');

    const bobPair: any = await w.auth.login('bob@mail.tn', BOB, '10.0.0.2');

    await w.auth.logoutEverywhere(w.alice.id);

    expect(w.memory.rows('authToken').filter((entry) => entry.userId === w.alice.id && entry.revokedAt === null)).toHaveLength(0);
    expect(w.memory.rows('authToken').filter((entry) => entry.userId === w.bob.id && entry.revokedAt === null)).toHaveLength(1);
    expect((await w.auth.refresh(bobPair.refreshToken) as any).user.id).toBe(w.bob.id);
  });
});

describe('POST /auth/forgot-password and /auth/reset-password with the wrong person (P1-17)', () => {
  it('answers the same for an account and for an e-mail nobody has, and writes to the owner of the address only', async () => {
    const w = await makeWorld();
    const known = await w.auth.forgotPassword('alice@mail.tn');
    const unknown = await w.auth.forgotPassword('nobody@mail.tn');

    expect(known).toEqual(unknown);
    expect(w.sent.map((message) => message.to)).toEqual(['alice@mail.tn']);
    expect(w.memory.rows('authToken').map((entry) => entry.userId)).toEqual([w.alice.id]);
  });

  it('a closed account is answered the same way, and gets nothing', async () => {
    const w = await makeWorld();

    row(w, 'user', w.alice.id).isActive = false;

    const closed = await w.auth.forgotPassword('alice@mail.tn');
    const unknown = await w.auth.forgotPassword('nobody@mail.tn');

    expect(closed).toEqual(unknown);
    expect(w.sent).toHaveLength(0);
  });

  it('the link changes the password of the account it was sent for, once, and ends that account\'s sessions only', async () => {
    const w = await makeWorld();

    await w.auth.login('alice@mail.tn', ALICE, '10.0.0.1');
    await w.auth.login('bob@mail.tn', BOB, '10.0.0.2');
    await w.auth.forgotPassword('alice@mail.tn');

    const token = tokenIn(w.sent[0].body);

    await w.auth.resetPassword(token, 'NewSecret789');

    expect(await argon2.verify(row(w, 'user', w.alice.id).password, 'NewSecret789')).toBe(true);
    expect(row(w, 'user', w.bob.id).password).toBe(w.bobHash);
    expect(w.memory.rows('authToken').filter((entry) => entry.userId === w.alice.id && entry.type === 'REFRESH' && entry.revokedAt === null)).toHaveLength(0);
    expect(w.memory.rows('authToken').filter((entry) => entry.userId === w.bob.id && entry.revokedAt === null)).toHaveLength(1);
    expect((await failure(w.auth.resetPassword(token, 'AnotherSecret000'))).getStatus()).toBe(400);
    expect(await argon2.verify(row(w, 'user', w.alice.id).password, 'NewSecret789')).toBe(true);
  });

  it('a made-up link, and none, change nothing', async () => {
    const w = await makeWorld();

    await w.auth.forgotPassword('alice@mail.tn');

    const before = JSON.stringify(w.memory.snapshot());

    expect((await failure(w.auth.resetPassword('made-up', 'NewSecret789'))).getStatus()).toBe(400);
    expect((await failure(w.auth.resetPassword(undefined as any, 'NewSecret789'))).getStatus()).toBe(400);
    expect(JSON.stringify(w.memory.snapshot())).toBe(before);
  });
});

describe('POST /auth/change-password with the wrong person (P1-17)', () => {
  it('needs the password of the caller: somebody else\'s does not do, and nothing changes', async () => {
    const w = await makeWorld();
    const error = await failure(w.auth.changePassword(w.alice.id, BOB, 'NewSecret789'));

    expect(error.getStatus()).toBe(400);
    expect(row(w, 'user', w.alice.id).password).toBe(w.aliceHash);
    expect(row(w, 'user', w.bob.id).password).toBe(w.bobHash);
  });

  it('changes the caller\'s password only, and ends their sessions only', async () => {
    const w = await makeWorld();

    await w.auth.login('alice@mail.tn', ALICE, '10.0.0.1');
    await w.auth.login('bob@mail.tn', BOB, '10.0.0.2');
    await w.auth.changePassword(w.alice.id, ALICE, 'NewSecret789');

    expect(await argon2.verify(row(w, 'user', w.alice.id).password, 'NewSecret789')).toBe(true);
    expect(row(w, 'user', w.bob.id).password).toBe(w.bobHash);
    expect(w.memory.rows('authToken').filter((entry) => entry.userId === w.bob.id && entry.revokedAt === null)).toHaveLength(1);
  });
});

describe('POST /auth/email/send-verification and /auth/email/verify with the wrong person (P1-17)', () => {
  it('writes to the caller\'s own address, and the link verifies that account only, once', async () => {
    const w = await makeWorld();

    await w.auth.sendEmailVerification(w.alice.id);

    expect(w.sent.map((message) => message.to)).toEqual(['alice@mail.tn']);

    const token = tokenIn(w.sent[0].body);

    await w.auth.verifyEmail(token);

    expect(row(w, 'user', w.alice.id).emailVerifiedAt).toBeTruthy();
    expect(row(w, 'user', w.bob.id).emailVerifiedAt ?? null).toBeNull();
    expect((await failure(w.auth.verifyEmail(token))).getStatus()).toBe(400);
  });

  it('a made-up link, and none, verify nothing', async () => {
    const w = await makeWorld();

    await w.auth.sendEmailVerification(w.alice.id);

    expect((await failure(w.auth.verifyEmail('made-up'))).getStatus()).toBe(400);
    expect((await failure(w.auth.verifyEmail(undefined as any))).getStatus()).toBe(400);
    expect(row(w, 'user', w.alice.id).emailVerifiedAt ?? null).toBeNull();
  });
});

describe('POST /auth/phone/send-code and /auth/phone/verify with the wrong person (P1-17)', () => {
  it('sends the code to the caller\'s own number, and the code verifies that account only', async () => {
    const w = await makeWorld();

    await w.auth.sendPhoneVerification(w.alice.id);

    expect(w.sent.map((message) => message.to)).toEqual(['22 123 456']);

    const code = /(\d{6})/.exec(w.sent[0].body)![1];
    const wrong = code === '123456' ? '654321' : '123456';

    // Bob has no code: Alice's does not verify his number, and nothing of Alice's changes either.
    expect((await failure(w.auth.verifyPhone(w.bob.id, code))).getStatus()).toBe(400);
    expect((await failure(w.auth.verifyPhone(w.alice.id, wrong))).getStatus()).toBe(400);
    expect(row(w, 'user', w.bob.id).phoneVerifiedAt ?? null).toBeNull();
    expect(row(w, 'user', w.alice.id).phoneVerifiedAt ?? null).toBeNull();

    await w.auth.verifyPhone(w.alice.id, code);

    expect(row(w, 'user', w.alice.id).phoneVerifiedAt).toBeTruthy();
    expect(row(w, 'user', w.bob.id).phoneVerifiedAt ?? null).toBeNull();
  });

  it('a code that was used is not good again', async () => {
    const w = await makeWorld();

    await w.auth.sendPhoneVerification(w.alice.id);

    const code = /(\d{6})/.exec(w.sent[0].body)![1];

    await w.auth.verifyPhone(w.alice.id, code);

    expect((await failure(w.auth.verifyPhone(w.alice.id, code))).getStatus()).toBe(400);
  });
});

describe('POST /users/me/email-change, /users/email-change/confirm and the phone twins with the wrong person (P1-17)', () => {
  it('needs the password of the caller: somebody else\'s does not do, and nothing is sent', async () => {
    const w = await makeWorld();
    const contact = w.contactChange;

    expect((await failure(contact.requestEmailChange(w.alice.id, { newEmail: 'new@mail.tn', currentPassword: BOB } as any))).getStatus()).toBe(400);
    expect((await failure(contact.requestPhoneChange(w.alice.id, { newPhone: '55 111 222', currentPassword: BOB } as any))).getStatus()).toBe(400);
    expect(w.sent).toHaveLength(0);
    expect(w.memory.rows('authToken')).toHaveLength(0);
  });

  it('the link of one person\'s change changes that person\'s address and nobody else\'s, and the code of one is no good to the other', async () => {
    const w = await makeWorld();
    const contact = w.contactChange;

    await contact.requestEmailChange(w.alice.id, { newEmail: 'alice.new@mail.tn', currentPassword: ALICE } as any);

    expect(w.sent.map((message) => message.to)).toEqual(['alice.new@mail.tn']);

    await contact.confirmEmailChange(tokenIn(w.sent[0].body));

    expect(row(w, 'user', w.alice.id).email).toBe('alice.new@mail.tn');
    expect(row(w, 'user', w.bob.id).email).toBe('bob@mail.tn');

    await contact.requestPhoneChange(w.alice.id, { newPhone: '55 111 222', currentPassword: ALICE } as any);

    const code = /(\d{6})/.exec(w.sent[w.sent.length - 1].body)![1];

    expect((await failure(contact.confirmPhoneChange(w.bob.id, code))).getStatus()).toBe(400);
    expect(row(w, 'user', w.bob.id).phone).toBe('98 765 432');
    expect(row(w, 'user', w.alice.id).phone).toBe('22 123 456');

    await contact.confirmPhoneChange(w.alice.id, code);

    expect(row(w, 'user', w.alice.id).phone).toBe('55 111 222');
    expect(row(w, 'user', w.bob.id).phone).toBe('98 765 432');
  });
});

describe('DELETE /users/me with the wrong person (P1-17)', () => {
  it('closes the caller\'s account and ends their sessions, and touches nobody else', async () => {
    const w = await makeWorld();

    await w.auth.login('alice@mail.tn', ALICE, '10.0.0.1');
    await w.auth.login('bob@mail.tn', BOB, '10.0.0.2');

    await w.usersService.deactivateAccount(w.alice.id);

    expect(row(w, 'user', w.alice.id).isActive).toBe(false);
    expect(row(w, 'user', w.alice.id).deletedAt).toBeTruthy();
    expect(row(w, 'user', w.bob.id).isActive).toBe(true);
    expect(row(w, 'user', w.bob.id).deletedAt ?? null).toBeNull();
    expect(row(w, 'user', w.bob.id).phoneKey).toBe('+21698765432');
    expect(w.memory.rows('authToken').filter((entry) => entry.userId === w.alice.id && entry.revokedAt === null)).toHaveLength(0);
    expect(w.memory.rows('authToken').filter((entry) => entry.userId === w.bob.id && entry.revokedAt === null)).toHaveLength(1);
    expect((await failure(w.auth.login('alice@mail.tn', ALICE, '10.0.0.1'))).getStatus()).toBe(401);
  });
});
