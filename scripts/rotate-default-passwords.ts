/**
 * One-off clean-up for accounts created before P0-04 (fixed passwords).
 *
 * Earlier versions created accounts with passwords that are written in the
 * source code and in the admin screen:
 *   "123456"        guest clients created by POST /interventions
 *   "Artisan2026!"  artisans created by approving an application
 *   "password123"   demo accounts created by prisma/seed.ts
 *
 * What it does for every account that still has one of those passwords:
 *   - replaces the password with a random one nobody knows;
 *   - revokes its refresh tokens (open sessions end when the access token expires);
 *   - prints the account, so that you can send the owner a "forgot password" link.
 * And for the old guest clients (guest_<number>@smart-depannage.com) among them:
 *   - marks them as guest profiles, so the guest flows (tracking, activation) work.
 *     (A public request reuses them even without this, see InterventionsService.)
 *
 * Usage (from the server folder, with DATABASE_URL in .env):
 *   npx ts-node scripts/rotate-default-passwords.ts           # dry run: only reports
 *   npx ts-node scripts/rotate-default-passwords.ts --apply   # writes the changes
 *
 * Take a database backup before running with --apply.
 */
import 'dotenv/config';

import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { AuthTokenType, PrismaClient } from '../generated/prisma/client';
import * as argon2 from 'argon2';
import * as crypto from 'crypto';

const KNOWN_DEFAULT_PASSWORDS = ['123456', 'Artisan2026!', 'password123'];
const LEGACY_GUEST_EMAIL = /^guest_\d+@smart-depannage\.com$/;

const apply = process.argv.includes('--apply');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function hasKnownPassword(hash: string): Promise<string | null> {
  if (!hash.startsWith('$argon2')) return null;

  for (const candidate of KNOWN_DEFAULT_PASSWORDS) {
    if (await argon2.verify(hash, candidate).catch(() => false)) {
      return candidate;
    }
  }

  return null;
}

async function main() {
  console.log(apply ? 'MODE: APPLY (writing)' : 'MODE: DRY RUN (nothing is written)');

  const users = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      role: true,
      password: true,
      isGuest: true,
      isActive: true,
    },
    orderBy: { id: 'asc' },
  });

  console.log(`Checking ${users.length} accounts...`);

  const rotated: { id: number; email: string; role: string; matched: string }[] = [];
  const legacyGuests: { id: number; email: string }[] = [];

  for (const user of users) {
    const isLegacyGuest = LEGACY_GUEST_EMAIL.test(user.email);
    const matched = await hasKnownPassword(user.password);

    // Only accounts that still have a built-in password are touched. A legacy
    // guest whose owner has since chosen a real password is a real account now.
    if (!matched) continue;

    rotated.push({
      id: user.id,
      email: user.email,
      role: user.role,
      matched,
    });

    const becomesGuest = isLegacyGuest && !user.isGuest;

    if (becomesGuest) {
      legacyGuests.push({ id: user.id, email: user.email });
    }

    if (!apply) continue;

    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: await argon2.hash(
          `Unusable-${crypto.randomBytes(48).toString('hex')}`,
        ),
        passwordChangedAt: new Date(),
        ...(becomesGuest ? { isGuest: true } : {}),
      },
    });

    await prisma.authToken.updateMany({
      where: {
        userId: user.id,
        type: AuthTokenType.REFRESH,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
  }

  console.log(`\nAccounts that still had a built-in password: ${rotated.length}`);
  for (const item of rotated) {
    console.log(`  #${item.id}  ${item.role.padEnd(11)} ${item.email}   (was "${item.matched}")`);
  }

  console.log(`\nLegacy guest clients marked as guest profiles: ${legacyGuests.length}`);

  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to write these changes.');
  } else if (rotated.length > 0) {
    console.log(
      '\nDone. These accounts can no longer log in with the old password.' +
        '\nTell their owners to use "Mot de passe oublié" (POST /api/auth/forgot-password) to choose a new one.',
    );
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
