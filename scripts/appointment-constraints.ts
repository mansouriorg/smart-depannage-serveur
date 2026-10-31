/**
 * One-off: make the database itself refuse two visits of one artisan at the same time (P3-01).
 *
 * The server already looks for a clash before it books a visit. This adds the last line, in PostgreSQL: an exclusion constraint on
 * the visits that hold an artisan's calendar. It needs the `btree_gist` extension (`CREATE EXTENSION` takes a database user with
 * the right to; on a managed database it is often a setting of the provider), and it cannot be created while two visits of an
 * artisan already overlap: the script lists them and writes nothing until they are settled. A visit that still stands on a cancelled job
 * (cancelled before a cancellation freed its visit) holds no hour: with --apply the script cancels it first, the way a cancellation does.
 *
 * Usage (from the server folder, with DATABASE_URL in .env):
 *   npm run scheduling:constraints             # dry run: looks, writes nothing
 *   npm run scheduling:constraints -- --apply  # creates the constraint
 *
 * It can be run again at any time. Prisma's schema cannot describe this constraint, so run this after `npx prisma db push` on a new
 * database, and check once, on a copy of the database, that your version of Prisma leaves the constraint in place. The exit code is
 * 1 when visits overlap or the extension is not offered (the constraint was not created; with --apply, visits that stood on cancelled
 * jobs may already have been cancelled), 2 on an error.
 */
import 'dotenv/config';

import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Status } from '../generated/prisma/client';
import { ensureOverlapConstraint } from '../src/modules/scheduling/appointment-constraints';
import { ACTIVE_APPOINTMENT_STATUSES } from '../src/modules/assignment/artisan-availability';
import { lockJob } from '../src/modules/assignment/artisan-lock';
import { cancelVisit } from '../src/modules/assignment/appointment-release';

const apply = process.argv.includes('--apply');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  console.log(apply ? 'APPLY: the constraint is created if nothing is in the way.\n' : 'DRY RUN: nothing is written.\n');

  const report = await ensureOverlapConstraint({
    db: prisma as any,
    apply,
    log: (line) => console.log(line),
    // The jobs of the visits that clash: whether a visit took place decides how it is settled.
    jobStatuses: async (ids) => {
      const jobs = await prisma.intervention.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } });

      return new Map(jobs.map((job) => [job.id, String(job.status)] as [number, string]));
    },
    // A cancelled job whose visit still holds an hour (a cancellation before P3-01 did not always free it): cancelled the way a cancellation does.
    visitsOfCancelledJobs: {
      find: async () => {
        const jobs = await prisma.intervention.findMany({
          where: { status: Status.CANCELLED, appointment: { is: { status: { in: ACTIVE_APPOINTMENT_STATUSES } } } },
          select: { id: true },
          orderBy: { id: 'asc' },
        });

        return jobs.map((job) => job.id);
      },
      release: async (ids) => {
        for (const id of ids) {
          await prisma.$transaction(async (tx) => {
            await lockJob(tx, id);
            await cancelVisit(tx as any, id, 'La mission avait été annulée: son rendez-vous est libéré.');
          });
        }
      },
    },
  });

  process.exitCode = report.ok ? 0 : 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 2;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
