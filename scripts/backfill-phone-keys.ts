/**
 * One-off, run right after the schema change of P1-03 step 4: give every existing
 * account its canonical phone key (User.phoneKey, the UNIQUE column).
 *
 * Accounts created before that change may share a phone number (a client and a
 * guest profile, two spellings of one number...). The rule: real accounts before
 * guest profiles, active ones before disabled ones, then the oldest. Deleted
 * accounts give their number up: they take no key, and one they hold is cleared.
 * The account that loses keeps its number as typed but gets no key; it is listed
 * so staff can fix it (change the number from the admin dashboard). No account
 * is deleted and no number is erased.
 *
 * Usage (from the server folder, with DATABASE_URL in .env):
 *   npm run phones:backfill             # dry run: only prints what would happen
 *   npm run phones:backfill -- --apply  # writes the keys
 *
 * Safe to run again: accounts that already have a key are not touched.
 * Run it before the new server accepts sign-ups: an account created by the new
 * server already has its key and keeps it against an older account that shares the number.
 * Until it has run, lookups still find an account by the number as typed.
 */
import 'dotenv/config';

import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { planPhoneKeys } from '../src/common/contact/phone-backfill';
import { maskPhone } from '../src/modules/notifications/delivery/contact';

const apply = process.argv.includes('--apply');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  console.log(apply ? 'APPLY: keys will be written.\n' : 'DRY RUN: nothing is written.\n');

  const rows = await prisma.user.findMany({
    where: { phone: { not: null } },
    select: { id: true, phone: true, phoneKey: true, phoneVerifiedAt: true, isGuest: true, isActive: true, deletedAt: true },
    orderBy: { id: 'asc' },
  });

  const plan = planPhoneKeys(rows);

  console.log(`${rows.length} account(s) with a phone number.`);
  console.log(`${plan.assign.length} key(s) to write.`);

  if (plan.release.length) {
    console.log(`${plan.release.length} deleted account(s) still hold a key: it is cleared (a deleted account gives its number up).`);
  }

  let written = 0;
  let raced = 0;

  if (apply) {
    // Cleared first, so a live account can take a number a deleted one was holding.
    if (plan.release.length) {
      await prisma.user.updateMany({ where: { id: { in: plan.release } }, data: { phoneKey: null } });
    }

    for (const item of plan.assign) {
      const row = rows.find((candidate: { id: number }) => candidate.id === item.id)!;

      try {
        // Only if the account still has the number that was read and no key yet:
        // an edit made while this script ran must not be overwritten with a stale key.
        const done = await prisma.user.updateMany({
          where: { id: item.id, phoneKey: null, phone: row.phone },
          data: { phoneKey: item.phoneKey },
        });

        if (done.count === 1) written += 1;
        else raced += 1;
      } catch (error: any) {
        // Somebody took the number between the read and the write: report it like any other duplicate.
        if (error?.code === 'P2002') {
          raced += 1;
          continue;
        }

        throw error;
      }
    }

    console.log(`${written} key(s) written${raced ? `, ${raced} lost a race (run again)` : ''}.`);
  }

  if (plan.conflicts.length) {
    console.log(`\n${plan.conflicts.length} number(s) used by several accounts. The first one keeps the key:`);

    for (const conflict of plan.conflicts) {
      console.log(
        `  ${maskPhone(conflict.phoneKey)}: account ${conflict.keep} keeps it; ` +
          `account(s) ${conflict.others.join(', ')} have the same number and no key. ` +
          'Change their number from the admin dashboard (or merge the accounts).',
      );
    }
  }

  if (plan.invalid.length) {
    console.log(`\n${plan.invalid.length} number(s) that cannot be a phone number (left as they are):`);

    for (const item of plan.invalid) {
      console.log(`  account ${item.id}: ${maskPhone(item.phone)}`);
    }
  }

  if (!apply && (plan.assign.length || plan.release.length)) {
    console.log('\nRun again with --apply to write the keys.');
  }
}

main()
  .catch((error) => {
    console.error('Backfill failed:', error?.message ?? error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
