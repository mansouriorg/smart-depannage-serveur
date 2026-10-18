import * as argon2 from 'argon2';

import { phoneColumns, phoneWhere } from '../../common/contact/phone';
import { Role } from '../../../generated/prisma/client';
import { generateUnusablePassword } from '../auth/password-setup';
import { lenientTradeFields } from './trade-fields';

/**
 * One-off, run when P1-11 is deployed (npm run applications:migrate): brings the applications
 * made with the older website form into the verification queue.
 *
 * The older form (POST /artisan-applications) kept a row of its own: name, e-mail, phone, one
 * word for the trade, the years, a text. It had no documents and no zones, and the back office
 * approved it from a page of its own. That chain is retired; a row still waiting would be lost.
 * For each pending row this makes what a new application makes: an account that cannot be used
 * yet, and an artisan profile waiting for review, with the trade read from the word (a word that
 * names no trade is kept as written and counts as "Autre"). The row is then marked MIGRATED and
 * kept for the record.
 *
 * What it does not make: documents and zones, which the row never had. Such a profile can only
 * be approved with the written exception (no identity document), or refused, or the applicant can
 * be asked to send the documents again by the back office. A row that cannot be brought over
 * (the e-mail or number belongs to another account, the number is not one) is listed with the
 * reason and left pending: nothing is lost, and the person can apply again with the new form.
 *
 * Running it again changes nothing for the rows already brought over.
 */
export type ApplicationMigrationReport = {
  pending: number;
  /** Rows that were (or, in a dry run, would be) brought into the queue. */
  migrated: Array<{ applicationId: number; userId?: number; profileId?: number }>;
  /** Rows left pending, and why. */
  skipped: Array<{ applicationId: number; reason: string }>;
};

type Db = object;

type Tables = {
  artisanApplication: {
    findMany: (args: any) => Promise<any[]>;
    updateMany: (args: any) => Promise<{ count: number }>;
  };
  user: {
    findFirst: (args: any) => Promise<any>;
    create: (args: any) => Promise<any>;
  };
  artisanProfile: {
    create: (args: any) => Promise<any>;
  };
  $transaction: <T>(work: (tx: any) => Promise<T>) => Promise<T>;
};

export async function migrateApplications(
  database: Db,
  options: { apply: boolean },
): Promise<ApplicationMigrationReport> {
  const db = database as Tables;

  const rows = await db.artisanApplication.findMany({
    where: { status: 'PENDING' },
    orderBy: { id: 'asc' },
  });

  const report: ApplicationMigrationReport = { pending: rows.length, migrated: [], skipped: [] };

  for (const row of rows) {
    const email = String(row.email ?? '').trim().toLowerCase();

    let phone: ReturnType<typeof phoneColumns>;

    try {
      phone = phoneColumns(row.phone);
    } catch {
      report.skipped.push({ applicationId: row.id, reason: 'the phone number is not a valid number' });
      continue;
    }

    const existing = await db.user.findFirst({
      where: { OR: [{ email }, phoneWhere(row.phone)].filter(Boolean) },
      include: { artisanProfile: true },
    });

    if (existing?.artisanProfile) {
      report.skipped.push({ applicationId: row.id, reason: 'an artisan profile already exists for this e-mail or number' });
      continue;
    }

    if (existing && existing.role !== Role.ARTISAN) {
      report.skipped.push({ applicationId: row.id, reason: 'the e-mail or number belongs to an account that is not an artisan' });
      continue;
    }

    if (!options.apply) {
      report.migrated.push({ applicationId: row.id });
      continue;
    }

    const trades = lenientTradeFields({ specialty: row.specialty });
    const password = await argon2.hash(generateUnusablePassword());

    try {
      const made = await db.$transaction(async (tx) => {
        // Only a row that is still pending: two runs at once cannot both bring it over.
        const claimed = await tx.artisanApplication.updateMany({
          where: { id: row.id, status: 'PENDING' },
          data: { status: 'MIGRATED' },
        });

        if (claimed.count !== 1) throw new Error('changed while the script ran');

        const user =
          existing ??
          (await tx.user.create({
            data: { name: row.name, email, ...phone, password, role: Role.ARTISAN, isActive: false },
          }));

        const profile = await tx.artisanProfile.create({
          data: {
            userId: user.id,
            specialty: trades?.specialty,
            specialties: trades?.specialties,
            serviceTypes: trades?.serviceTypes,
            yearsExperience: typeof row.experience === 'number' ? row.experience : undefined,
            bio: row.description ?? undefined,
            verificationStatus: 'PENDING_REVIEW',
          },
        });

        return { userId: user.id as number, profileId: profile.id as number };
      });

      report.migrated.push({ applicationId: row.id, ...made });
    } catch (error) {
      report.skipped.push({
        applicationId: row.id,
        reason: error instanceof Error && error.message === 'changed while the script ran' ? error.message : 'could not be written (run the script again)',
      });
    }
  }

  return report;
}
