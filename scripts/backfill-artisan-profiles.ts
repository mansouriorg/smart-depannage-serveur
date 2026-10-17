/**
 * One-off, run right after P1-05 is deployed: see src/modules/artisans/profile-backfill.ts
 * for what it does and why.
 *
 * Usage (from the server folder, with DATABASE_URL in .env):
 *   npm run artisans:backfill                          # dry run: only prints what would happen
 *   npm run artisans:backfill -- --apply               # gives a profile to the artisans that have none
 *   npm run artisans:backfill -- --apply --emergency-on  # and makes approved artisans available for urgent jobs
 *   npm run artisans:backfill -- --apply --switch-on     # and switches missions on for approved artisans that have them off
 *
 * `--apply` alone is safe to run again, any time. `--emergency-on` and `--switch-on` are not:
 * they cannot tell a flag nobody ever set from one an artisan turned off on purpose, so run
 * them ONCE, after reading the dry run, and not again.
 * Only account numbers are printed, never names or contact details.
 */
import 'dotenv/config';

import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { backfillArtisanProfiles } from '../src/modules/artisans/profile-backfill';

const apply = process.argv.includes('--apply');
const switchOn = process.argv.includes('--switch-on');
const emergencyOn = process.argv.includes('--emergency-on');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const list = (ids: number[]) => (ids.length ? ids.join(', ') : 'none');

async function main() {
  console.log(apply ? 'APPLY: the changes below are written.\n' : 'DRY RUN: nothing is written.\n');

  const report = await backfillArtisanProfiles(prisma as any, { apply, switchOn, emergencyOn });

  console.log(`Active artisan accounts with no profile (cannot be given a job): ${report.withoutProfile.length}`);
  console.log(`  accounts: ${list(report.withoutProfile)}`);

  if (report.withoutProfileInactive.length) {
    console.log(`Inactive or deleted artisan accounts with no profile (left alone): ${report.withoutProfileInactive.length}`);
    console.log(`  accounts: ${list(report.withoutProfileInactive)}`);
  }

  console.log(`Approved artisans who do not accept missions (cannot be given a job): ${report.notAccepting.length}`);
  console.log(`  accounts: ${list(report.notAccepting)}`);

  console.log(`Approved artisans not available for urgent jobs (an urgent job cannot be given to them): ${report.noEmergency.length}`);
  console.log(`  accounts: ${list(report.noEmergency)}`);

  if (apply) {
    console.log(`\nProfiles created: ${report.created.length}`);
    console.log(`Made available for urgent jobs: ${report.emergencyOn.length}${emergencyOn ? '' : ' (add --emergency-on to do it, once)'}`);
    console.log(`Missions switched on: ${report.switchedOn.length}${switchOn ? '' : ' (add --switch-on to switch them on, once)'}`);

    if (emergencyOn || switchOn) {
      console.log('\nThese two flags are for one run only: run again, they would switch back on what an artisan turned off since.');
    }

    if (report.raced.length) console.log(`Changed while the script ran, left as they are: ${list(report.raced)}`);
  } else {
    console.log('\nRun again with --apply to give a profile to the first group. Add --emergency-on to make the third group available for urgent jobs, and --switch-on to switch the second group on (each once: an artisan may have turned it off on purpose).');
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
