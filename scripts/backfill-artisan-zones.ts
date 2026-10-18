/**
 * One-off, run when P1-11 is deployed: see src/modules/artisans/zone-backfill.ts for what it does
 * and why.
 *
 * Usage (from the server folder, with DATABASE_URL in .env):
 *   npm run zones:backfill             # dry run: lists the zones it would fill, and the ones it cannot
 *   npm run zones:backfill -- --apply  # writes the centre and radius of the zones it can place
 *
 * Run it after `npx prisma generate && npx prisma db push` and after `npm run zones:seed`. `--apply`
 * first saves the old values of the zones it changes in zones-backup-<date>.json (in the folder you
 * are in) and stops if that file cannot be written. It is safe to run again. Only zone and profile
 * numbers and the words typed as a zone name are printed, never names or contact details.
 */
import 'dotenv/config';

import { writeFileSync } from 'fs';

import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { backfillZones } from '../src/modules/artisans/zone-backfill';

const apply = process.argv.includes('--apply');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const words = (values: string[]) => (values.length ? values.map((word) => `« ${word} »`).join(', ') : '(empty)');

async function main() {
  console.log(apply ? 'APPLY: the zones below are written.\n' : 'DRY RUN: nothing is written.\n');

  const report = await backfillZones(prisma, {
    apply,
    beforeWrite: (changes) => {
      const file = `zones-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

      writeFileSync(file, JSON.stringify(changes, null, 2), { flag: 'wx' });
      console.log(`Old values of ${changes.length} zone(s) saved in ${file}\n`);
    },
  });

  console.log(`Artisan zones with no centre: ${report.withoutCentre}`);
  console.log(`${apply ? 'Zones filled' : 'Zones that would be filled'}: ${report.changes.length}`);

  for (const change of report.changes) {
    console.log(`  zone ${change.zoneId} (profile ${change.profileId}): ${words([change.before.label ?? '', change.before.city ?? ''].filter(Boolean))} -> ${change.platformZoneName}`);
  }

  console.log(`Zones that name no platform zone (left as they are; the artisan is not limited by them): ${report.unmatched.length}`);

  for (const item of report.unmatched) {
    console.log(`  zone ${item.zoneId}: ${words(item.words)}`);
  }

  if (report.ambiguous.length) {
    console.log(`Zones that name more than one platform zone (left as they are): ${report.ambiguous.length}`);

    for (const item of report.ambiguous) {
      console.log(`  zone ${item.zoneId}: ${words(item.words)} -> ${item.candidates.join(' / ')}`);
    }
  }

  if (apply) {
    console.log(`\nZones written: ${report.written.length}`);

    if (report.raced.length) console.log(`Changed while the script ran, left as they are (run again): ${report.raced.join(', ')}`);
  } else if (report.changes.length) {
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
