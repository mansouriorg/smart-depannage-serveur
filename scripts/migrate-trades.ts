/**
 * One-off, run when P1-10 is deployed: see src/modules/artisans/trade-migration.ts for what it
 * does and why.
 *
 * Usage (from the server folder, with DATABASE_URL in .env):
 *   npm run trades:migrate             # dry run: prints, for each profile, the old and the new values
 *   npm run trades:migrate -- --apply  # writes the trades on every artisan profile
 *
 * Run it after `npx prisma generate && npx prisma db push` (the service type list gained three
 * values) and after the catalog seed. The words are rewritten as the labels of the table, so
 * `--apply` first saves the old values of the profiles it changes in trades-backup-<date>.json
 * (in the folder you are in) and stops if that file cannot be written. `--apply` is safe to run
 * again, any time. Only profile numbers and the words typed as a specialty are printed, never
 * names or contact details.
 */
import 'dotenv/config';

import { writeFileSync } from 'fs';

import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { migrateTrades } from '../src/modules/artisans/trade-migration';

const apply = process.argv.includes('--apply');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const list = (ids: number[]) => (ids.length ? ids.join(', ') : 'none');
const words = (values: string[]) => (values.length ? values.map((word) => `« ${word} »`).join(', ') : '(empty)');

async function main() {
  console.log(apply ? 'APPLY: the changes below are written.\n' : 'DRY RUN: nothing is written.\n');

  let backupFile = '';

  const report = await migrateTrades(prisma as any, {
    apply,
    // The words are rewritten, so the old values are kept first; if this fails nothing is written.
    beforeWrite: (changes) => {
      backupFile = `trades-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      writeFileSync(backupFile, JSON.stringify(changes, null, 2), { flag: 'wx' });
      console.log(`Old values of ${changes.length} profile(s) saved in ${backupFile}\n`);
    },
  });

  console.log(`Artisan profiles read: ${report.profiles}`);
  console.log(`Profiles whose trades are written from their specialty: ${report.toChange.length}`);

  for (const change of report.changes) {
    console.log(`  profile ${change.profileId}`);
    console.log(
      `    now:  specialty ${change.before.specialty === null ? '(none)' : `« ${change.before.specialty} »`}, list ${words(change.before.specialties)}, types ${change.before.serviceTypes.join(', ') || '(none)'}`,
    );
    console.log(
      `    then: specialty « ${change.after.specialty} », list ${words(change.after.specialties)}, types ${change.after.serviceTypes.join(', ')}`,
    );
  }

  console.log(`Profiles with no specialty and no service type at all (they keep seeing every job): ${report.withoutTrades.length}`);
  console.log(`  profiles: ${list(report.withoutTrades)}`);

  if (report.typesOnly.length) {
    console.log(`Profiles with service types but no specialty text (left as they are): ${report.typesOnly.length}`);
    console.log(`  profiles: ${list(report.typesOnly)}`);
  }

  if (report.inferred.length) {
    console.log(`Profiles with a text that is not a trade's name, read through a keyword (a guess, check them): ${report.inferred.length}`);

    for (const item of report.inferred) {
      console.log(`  profile ${item.profileId}: ${words(item.words)}`);
    }
  }

  if (report.unrecognized.length) {
    console.log(`Profiles with a specialty that names no trade (kept as written, counted as "Autre"): ${report.unrecognized.length}`);

    for (const item of report.unrecognized) {
      console.log(`  profile ${item.profileId}: ${words(item.words)}`);
    }
  }

  if (apply) {
    console.log(`\nProfiles written: ${report.written.length}`);

    if (report.raced.length) console.log(`Changed while the script ran, left as they are (run again): ${list(report.raced)}`);
  } else {
    console.log('\nRun again with --apply to write them (the old values are saved in a file first).');
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
