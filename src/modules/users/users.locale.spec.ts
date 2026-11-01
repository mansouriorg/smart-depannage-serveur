import { readFileSync } from 'fs';
import { join } from 'path';

import { NotFoundException } from '@nestjs/common';
import * as argon2 from 'argon2';

import { LOCALES } from '../../common/i18n/i18n';
import { MemoryPrisma } from '../../common/testing/memory-prisma';
import { ROUTE_ACCESS } from '../../common/testing/route-access.golden';
import { accountSelfScenarios } from '../../common/testing/access/accounts';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { AUDITED_ROUTES } from '../audit/audit-actions';
import { AuthService } from '../auth/auth.service';
import { ContactChangeService } from './contact-change.service';
import { UsersService } from './users.service';

process.env.FRONTEND_URL = 'https://app.example.tn';
process.env.JWT_ACCESS_SECRET = 'a'.repeat(40);
process.env.JWT_REFRESH_SECRET = 'b'.repeat(40);

/**
 * The language of an account (P3-04): PATCH /users/me/locale, and the answers that carry it (login, refresh, who am I).
 * The real UsersService and AuthService on the in-memory database; what leaves is not looked at here.
 */
const PASSWORD = 'AliceSecret123';

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
  const hash = await argon2.hash(PASSWORD);

  const alice = memory.plant('user', { email: 'alice@mail.tn', password: hash, name: 'Alice', role: 'CLIENT', isActive: true, isGuest: false, phone: '22 123 456', phoneKey: '+21622123456' });
  const bob = memory.plant('user', { email: 'bob@mail.tn', password: hash, name: 'Bob', role: 'ARTISAN', isActive: true, isGuest: false, phone: '98 765 432', phoneKey: '+21698765432' });
  const admin = memory.plant('user', { email: 'admin@mail.tn', password: hash, name: 'Admin', role: 'ADMIN', isActive: true, isGuest: false });

  const notifications: any = {
    sendEmail: async () => ({ queued: true }),
    sendSms: async () => ({ queued: true }),
    isEmailSimulated: () => false,
    isSmsSimulated: () => false,
  };

  const rateLimit = new RateLimitService();
  const contactChange = new ContactChangeService(prisma, notifications, rateLimit);
  const users = new UsersService(prisma, notifications, contactChange);
  const auth = new AuthService(users, fakeJwt() as any, prisma, notifications, rateLimit);

  return { memory, users, auth, alice, bob, admin };
}

const rowOf = (w: { memory: MemoryPrisma }, id: number) => w.memory.rows('user').find((entry) => entry.id === id) as any;

describe('the language of an account is French until the person chooses (P3-04)', () => {
  it('a new account starts in French', async () => {
    const w = await makeWorld();

    expect(rowOf(w, w.alice.id).locale).toBe('fr');
    expect(rowOf(w, w.admin.id).locale).toBe('fr');
  });

  it('the schema has the column, as text with the default "fr" (the list of languages is the shared package’s, not an enum)', () => {
    const schema = readFileSync(join(__dirname, '../../../prisma/schema.prisma'), 'utf8');
    const user = /model User \{([\s\S]*?)\n\}/.exec(schema)?.[1] ?? '';

    expect(user).toMatch(/\n\s+locale\s+String\s+@default\("fr"\)/);
  });
});

describe('PATCH /users/me/locale writes the language and nothing else (P3-04)', () => {
  it('answers { locale } and stores it', async () => {
    const w = await makeWorld();

    expect(await w.users.setLocale(w.alice.id, 'ar')).toEqual({ locale: 'ar' });
    expect(rowOf(w, w.alice.id).locale).toBe('ar');

    expect(await w.users.setLocale(w.alice.id, 'fr')).toEqual({ locale: 'fr' });
    expect(rowOf(w, w.alice.id).locale).toBe('fr');
  });

  it('changes no other column of the account, and nobody else’s', async () => {
    const w = await makeWorld();
    const strip = (row: any) => {
      const { locale, updatedAt, ...rest } = row;

      return JSON.stringify(rest);
    };
    const before = { alice: strip(rowOf(w, w.alice.id)), bob: strip(rowOf(w, w.bob.id)), bobLocale: rowOf(w, w.bob.id).locale };

    await w.users.setLocale(w.alice.id, 'ar');

    expect(strip(rowOf(w, w.alice.id))).toBe(before.alice);
    expect(strip(rowOf(w, w.bob.id))).toBe(before.bob);
    expect(rowOf(w, w.bob.id).locale).toBe(before.bobLocale);
  });

  it('is open to every kind of account, the back office included', async () => {
    const w = await makeWorld();

    for (const person of [w.alice, w.bob, w.admin]) {
      expect(await w.users.setLocale(person.id, 'ar')).toEqual({ locale: 'ar' });
    }
  });

  it('an account that does not exist, or that was deleted, is not found', async () => {
    const w = await makeWorld();

    let error: any;
    try {
      await w.users.setLocale(9999, 'ar');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(NotFoundException);

    const gone = w.memory.plant('user', { email: 'gone@mail.tn', name: 'Gone', role: 'CLIENT', isActive: false, deletedAt: new Date() });
    let again: any;
    try {
      await w.users.setLocale(gone.id as number, 'ar');
    } catch (caught) {
      again = caught;
    }
    expect(again).toBeInstanceOf(NotFoundException);
    expect(rowOf(w, gone.id as number).locale).toBe('fr');
  });
});

describe('the route is as the other routes of a signed-in account (P3-04)', () => {
  const controller = readFileSync(join(__dirname, 'users.controller.ts'), 'utf8');
  const dto = readFileSync(join(__dirname, 'dto/update-locale.dto.ts'), 'utf8');

  it('is in the table of routes: any signed-in account, no permission', () => {
    expect(ROUTE_ACCESS['PATCH /users/me/locale']).toBe('signed-in');
  });

  it('has its scenario in the access suite, as a route that serves the caller', () => {
    const scenario = accountSelfScenarios.find((entry) => entry.route === 'PATCH /users/me/locale');

    expect(scenario).toBeDefined();
    expect((scenario as any).request().body).toEqual({ locale: 'ar' });
  });

  it('is in the audit list as a self-service write (the language of an account is a change of an account)', () => {
    expect(AUDITED_ROUTES['PATCH /users/me/locale']).toMatchObject({ action: 'account.set-locale', targetType: 'User', self: true });
  });

  it('needs a signed-in account (401 without a token), and only the caller’s own id comes from the token', () => {
    const at = controller.indexOf("@Patch('me/locale')");
    const handler = controller.slice(controller.lastIndexOf('// PATCH /users/me/locale', at), controller.indexOf('// DELETE /users/me', at));

    expect(at).toBeGreaterThan(0);
    expect(handler).toContain('@UseGuards(JwtAuthGuard)');
    expect(handler).not.toContain('PermissionsGuard');
    expect(handler).toContain("@CurrentUser('id') userId: number");
    expect(handler).toContain('@Body() dto: UpdateLocaleDto');
    expect(handler).toContain('this.usersService.setLocale(userId, dto.locale)');
    expect(handler).not.toMatch(/@Param\(/);
  });

  it('is declared before PATCH :id, which would otherwise take "me"', () => {
    expect(controller.indexOf("@Patch('me/locale')")).toBeGreaterThan(0);
    expect(controller.indexOf("@Patch('me/locale')")).toBeLessThan(controller.indexOf("@Patch(':id')"));
  });

  it('the body is checked: only "fr" or "ar", and no other field (the global pipe refuses what the DTO does not name)', () => {
    expect(dto).toContain("@IsIn(LOCALES)");
    expect(dto).toMatch(/locale: \(typeof LOCALES\)\[number\];/);
    expect(dto.match(/^\s{2}\w+[?!]?:/gm)).toEqual(['  locale:']);
    expect([...LOCALES]).toEqual(['fr', 'ar']);
  });

  it('the language is not also changed by PATCH /users/me or by the admin’s user update', () => {
    const profile = readFileSync(join(__dirname, 'dto/update-profile.dto.ts'), 'utf8');
    const admin = readFileSync(join(__dirname, 'dto/update-user-admin.dto.ts'), 'utf8');

    expect(profile).not.toMatch(/locale/);
    expect(admin).not.toMatch(/locale/);
  });
});

describe('the answers that carry the language (P3-04)', () => {
  it('login answers user.locale, French by default, and the password hash still stays out', async () => {
    const w = await makeWorld();

    const answer: any = await w.auth.login('alice@mail.tn', PASSWORD, '10.0.0.1');

    expect(answer.user.locale).toBe('fr');
    expect(answer.user.email).toBe('alice@mail.tn');
    expect(answer.user).not.toHaveProperty('password');
    expect(typeof answer.accessToken).toBe('string');
  });

  it('login answers the language the person chose', async () => {
    const w = await makeWorld();

    await w.users.setLocale(w.alice.id, 'ar');

    const answer: any = await w.auth.login('alice@mail.tn', PASSWORD, '10.0.0.1');

    expect(answer.user.locale).toBe('ar');
  });

  it('the back office’s login carries it too (it can hold Arabic, and is still written to in French)', async () => {
    const w = await makeWorld();

    await w.users.setLocale(w.admin.id, 'ar');

    const answer: any = await w.auth.login('admin@mail.tn', PASSWORD, '10.0.0.1');

    expect(answer.user.locale).toBe('ar');
  });

  it('refresh answers it, from the account as it is now', async () => {
    const w = await makeWorld();

    const first: any = await w.auth.login('alice@mail.tn', PASSWORD, '10.0.0.1');
    await w.users.setLocale(w.alice.id, 'ar');
    const next: any = await w.auth.refresh(first.refreshToken);

    expect(next.user.locale).toBe('ar');
    expect(next.user).not.toHaveProperty('password');
  });

  it('who am I (GET /users/me and /users/profile) answers it', async () => {
    const w = await makeWorld();

    expect((await w.users.getProfile(w.alice.id)).locale).toBe('fr');

    await w.users.setLocale(w.alice.id, 'ar');

    expect((await w.users.getProfile(w.alice.id)).locale).toBe('ar');
  });

  it('PATCH /users/me answers it too, and a change of name does not touch it', async () => {
    const w = await makeWorld();

    await w.users.setLocale(w.alice.id, 'ar');

    const answer: any = await w.users.updateProfile(w.alice.id, { name: 'Alice B.' } as any);

    expect(answer.name).toBe('Alice B.');
    expect(answer.locale).toBe('ar');
    expect(rowOf(w, w.alice.id).locale).toBe('ar');
  });
});
