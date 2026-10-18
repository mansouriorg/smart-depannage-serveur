import { profileMigration } from './trade-fields';

/**
 * One-off, run when P1-10 is deployed (npm run trades:migrate): gives every artisan profile made
 * before the table of trades the three fields it should have.
 *
 * A profile had its specialty as free text ("Plombier", "Climatisation", "Polyvalent") and an
 * empty list of service types, so the board of open jobs could not tell which jobs were theirs.
 * For each profile the script reads the words, writes them back as the labels of the table, and
 * writes the service types they point to.
 *
 *  - a word that names no trade ("Maçon") is kept as written and the profile gets "Autre", so it
 *    still sees the jobs of that kind; the word is listed, for the back office to look at;
 *  - a text that is not a trade's name but contains a keyword of one ("Pose de portes et
 *    fenêtres") is read as that trade and listed apart, because it is a guess;
 *  - the service types already on a profile stay, the new ones are added;
 *  - a profile with no word at all is only listed: there is nothing to read, and it keeps seeing
 *    every job (or the jobs of the service types it already has);
 *  - a profile edited while the script ran is left as it is (it is read again the next time).
 *
 * The words are rewritten as the labels of the table, so before anything is written the old
 * values of every profile that changes are handed to `beforeWrite` (the script saves them in a
 * file) and nothing is written if that fails. The dry run lists the old and the new values.
 * Running it again changes nothing.
 */
export type TradeValues = { specialty: string | null; specialties: string[]; serviceTypes: string[] };

export type TradeMigrationReport = {
  /** Profiles read. */
  profiles: number;
  /** Profiles with no specialty and no service type at all. */
  withoutTrades: number[];
  /** Profiles with service types but no specialty text: nothing to read, left as they are. */
  typesOnly: number[];
  /** Profiles whose fields differ from what the table gives. */
  toChange: number[];
  /** What each of them has now and what it would have. */
  changes: Array<{ profileId: number; before: TradeValues; after: TradeValues }>;
  /** Words that name no trade, by profile (they count as "Autre"). */
  unrecognized: Array<{ profileId: number; words: string[] }>;
  /** Texts read through a keyword only, by profile: a guess to check. */
  inferred: Array<{ profileId: number; words: string[] }>;
  written: number[];
  /** Edited while the script ran: left as they are. */
  raced: number[];
};

type Db = {
  artisanProfile: {
    findMany: (args: any) => Promise<any[]>;
    updateMany: (args: any) => Promise<{ count: number }>;
  };
};

export async function migrateTrades(
  db: Db,
  options: {
    apply: boolean;
    /** Called with the old values of the profiles to change, before the first write; if it throws, nothing is written. */
    beforeWrite?: (changes: TradeMigrationReport['changes']) => Promise<void> | void;
  },
): Promise<TradeMigrationReport> {
  const profiles = await db.artisanProfile.findMany({
    select: { id: true, specialty: true, specialties: true, serviceTypes: true, updatedAt: true },
    orderBy: { id: 'asc' },
  });

  const report: TradeMigrationReport = {
    profiles: profiles.length,
    withoutTrades: [],
    typesOnly: [],
    toChange: [],
    changes: [],
    unrecognized: [],
    inferred: [],
    written: [],
    raced: [],
  };

  const plans: Array<{ profile: any; fields: NonNullable<ReturnType<typeof profileMigration>>['fields'] }> = [];

  for (const profile of profiles) {
    const plan = profileMigration({
      specialty: profile.specialty ?? null,
      specialties: profile.specialties ?? [],
      serviceTypes: profile.serviceTypes ?? [],
    });

    if (!plan) {
      if ((profile.serviceTypes ?? []).length) report.typesOnly.push(profile.id);
      else report.withoutTrades.push(profile.id);
      continue;
    }

    if (plan.unrecognized.length) report.unrecognized.push({ profileId: profile.id, words: plan.unrecognized });
    if (plan.inferred.length) report.inferred.push({ profileId: profile.id, words: plan.inferred });

    if (plan.changed) {
      report.toChange.push(profile.id);
      report.changes.push({
        profileId: profile.id,
        before: {
          specialty: profile.specialty ?? null,
          specialties: [...(profile.specialties ?? [])],
          serviceTypes: [...(profile.serviceTypes ?? [])],
        },
        after: { ...plan.fields },
      });
      plans.push({ profile, fields: plan.fields });
    }
  }

  if (!options.apply) return report;

  // The old values are kept before anything is rewritten; a backup that fails stops the run.
  if (options.beforeWrite && report.changes.length) await options.beforeWrite(report.changes);

  for (const { profile, fields } of plans) {
    // Only if nobody changed the profile since it was read.
    const done = await db.artisanProfile.updateMany({
      where: { id: profile.id, updatedAt: profile.updatedAt },
      data: { specialty: fields.specialty, specialties: fields.specialties, serviceTypes: fields.serviceTypes },
    });

    if (done.count === 1) report.written.push(profile.id);
    else report.raced.push(profile.id);
  }

  return report;
}
