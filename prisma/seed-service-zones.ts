import 'dotenv/config';

import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../generated/prisma/client';
import { GOVERNORATES } from '../src/modules/service-zones/governorates';
import { seedServiceZones } from '../src/modules/service-zones/zone-seed';

/**
 * Run when P1-11 is deployed (npm run zones:seed): creates the 24 governorates as service zones
 * of the platform, the list an applicant picks from. It only adds the ones that are missing and
 * leaves a zone that exists as it is (name, radius, on or off), except that a zone with no centre
 * (the older settings screen allowed that) gets the list's centre, so it can be picked. Safe on a
 * database that is already in use and safe to run again. The centres and radii are starting values: check them with
 * GET /api/admin/settings/service-zones and change one with PATCH /api/admin/settings/service-zones/<id>
 * (the dashboard has no screen for them yet).
 */
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is missing in your .env file.');
}

const pool = new Pool({ connectionString: databaseUrl });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  const report = await seedServiceZones(prisma, GOVERNORATES);

  console.log(
    `✅ Service zones: ${report.created.length} created, ${report.filled.length} given a centre, ${report.kept.length} already there (left as they are).`,
  );

  if (report.created.length) console.log(`   created: ${report.created.join(', ')}`);
  if (report.filled.length) console.log(`   centre filled in: ${report.filled.join(', ')}`);
}

main()
  .catch((error) => {
    console.error('❌ Error while seeding service zones:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
