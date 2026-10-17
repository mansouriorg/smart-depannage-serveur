/**
 * One-off: rewrite the old intervention status names to the canonical ones (P1-01).
 *
 *   PENDING        -> CREATED
 *   ADMIN_REVIEW   -> WAITING_ADMIN_REVIEW
 *   ACCEPTED       -> ARTISAN_ACCEPTED
 *   ON_THE_WAY     -> ARTISAN_ON_THE_WAY
 *   ARRIVED        -> ARTISAN_ARRIVED
 *   INVOICE_READY  -> INVOICE_SENT
 *
 * DO NOT RUN THIS BEFORE THE APPS ARE UPDATED. The admin dashboard, the mobile
 * app and the website still compare against PENDING / ACCEPTED / IN_PROGRESS.
 * Run it in the same release that switches the server to STATUS_STORAGE=canonical
 * and ships the updated apps (P1-12, P1-15, P1-16). Until then the server keeps
 * writing the spelling it was given, and every filter already matches both.
 *
 * Usage (from the server folder, with DATABASE_URL in .env):
 *   npm run status:migrate-vocabulary             # dry run: only counts
 *   npm run status:migrate-vocabulary -- --apply  # rewrites the rows
 *
 * Take a database backup before running with --apply.
 */
import 'dotenv/config';

import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { LEGACY_STATUS_ALIASES } from '../src/modules/intervention-workflow/intervention-status';

const apply = process.argv.includes('--apply');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  console.log(apply ? 'APPLY: rows will be rewritten.\n' : 'DRY RUN: nothing is written.\n');

  let total = 0;

  for (const [oldName, newName] of Object.entries(LEGACY_STATUS_ALIASES)) {
    const count = await prisma.intervention.count({ where: { status: oldName as any } });
    total += count;

    console.log(`${oldName.padEnd(14)} -> ${newName.padEnd(22)} ${count} row(s)`);

    if (apply && count > 0) {
      // Only the spelling changes: the moment of the last status change stays as it was.
      await prisma.intervention.updateMany({
        where: { status: oldName as any },
        data: { status: newName as any },
      });
    }
  }

  console.log(`\n${total} row(s) ${apply ? 'rewritten' : 'would be rewritten'}.`);

  if (!apply && total > 0) {
    console.log('Run again with --apply once the apps are updated and STATUS_STORAGE=canonical is set.');
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
