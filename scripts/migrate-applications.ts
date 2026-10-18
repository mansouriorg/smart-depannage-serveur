/**
 * One-off, run when P1-11 is deployed: see src/modules/artisans/application-migration.ts for what
 * it does and why.
 *
 * Usage (from the server folder, with DATABASE_URL in .env):
 *   npm run applications:migrate             # dry run: lists what would be brought into the queue
 *   npm run applications:migrate -- --apply  # writes the accounts and profiles, marks the rows MIGRATED
 *
 * Run it after `npx prisma generate && npx prisma db push` (the MIGRATED status is new). It is safe
 * to run again. Only application numbers and reasons are printed, never names or contact details.
 */
import 'dotenv/config';

import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { migrateApplications } from '../src/modules/artisans/application-migration';

const apply = process.argv.includes('--apply');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  console.log(apply ? 'APPLY: the applications below are brought into the queue.\n' : 'DRY RUN: nothing is written.\n');

  const report = await migrateApplications(prisma, { apply });

  console.log(`Applications still pending: ${report.pending}`);
  console.log(`${apply ? 'Brought into the queue' : 'Would be brought into the queue'}: ${report.migrated.length}`);

  for (const item of report.migrated) {
    console.log(`  application ${item.applicationId}${item.profileId ? ` -> profile ${item.profileId}` : ''}`);
  }

  console.log(`Left pending: ${report.skipped.length}`);

  for (const item of report.skipped) {
    console.log(`  application ${item.applicationId}: ${item.reason}`);
  }

  if (report.migrated.length) {
    console.log('\nThese profiles have no documents and no zones (the older form had none).');
    console.log('Approve them with the written exception, or refuse them, from the verification queue.');
  }

  if (!apply && report.migrated.length) {
    console.log('\nRun again with --apply to write them.');
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
