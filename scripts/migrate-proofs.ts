/**
 * One-off: put the proof photos taken before P1-07 behind the login.
 *
 * Before, a proof photo was a file in `uploads/proofs/`, served to anybody who knew its address.
 * Now it is a private file read through `/api/files/:id/download`, with a row in ProofCapture.
 * This script copies each old file to the private folder, writes its rows, points the intervention
 * at the new address and removes the old file. See src/modules/proofs/legacy-proofs.ts.
 *
 * Run it after `npx prisma db push` (the ProofCapture table must exist) and before or just after
 * the new server starts. Until it has run, the old photos are no longer served: the files are
 * safe in `uploads/proofs/`, the dashboard shows a missing picture.
 *
 * Usage (from the server folder, with DATABASE_URL in .env):
 *   npm run proofs:migrate             # dry run: only counts
 *   npm run proofs:migrate -- --apply  # does it
 *
 * It can be run again at any time. Take a backup of the database and of `uploads/` first.
 */
import 'dotenv/config';

import { join } from 'path';

import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { migrateLegacyProofs } from '../src/modules/proofs/legacy-proofs';

const apply = process.argv.includes('--apply');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  console.log(apply ? 'APPLY: files are moved and rows are written.\n' : 'DRY RUN: nothing is written.\n');

  const report = await migrateLegacyProofs({
    db: prisma as any,
    uploadRoot: join(process.cwd(), 'uploads'),
    apply,
    log: (line) => console.log(line),
  });

  console.log(`
${report.looked} photo(s) looked at
${report.moved} old public file(s) ${apply ? 'moved behind the login' : 'would be moved'}
${report.prefixed} address(es) ${apply ? 'given' : 'would be given'} their /api prefix
${report.madePrivate} public proof file(s) ${apply ? 'made private' : 'would be made private'}
${report.captured} capture row(s) ${apply ? 'written' : 'would be written'}
${report.alreadyDone} already done
${report.duplicates} photo(s) found on more than one job (kept, marked for review)
${report.missingFiles} photo(s) whose file is missing (left as they are)
${report.external.length} address(es) outside the server or not a proof photo (left as they are)
${report.failures.length} failure(s)`);

  if (report.external.length) {
    console.log('\nAddresses outside the server, or files that are not proof photos:');
    for (const item of report.external) console.log(`  intervention #${item.interventionId} (${item.column})`);
  }

  if (report.failures.length) {
    console.log('\nFailures (run again once the cause is fixed):');
    for (const item of report.failures) console.log(`  intervention #${item.interventionId} (${item.column}): ${item.reason}`);
    process.exitCode = 1;
  }

  if (!apply && report.looked > 0) console.log('\nRun again with --apply to do it.');
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
