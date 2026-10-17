import { ArtisanVerificationStatus, Role } from '../../../generated/prisma/client';
import { approvedProfileData } from './approved-profile';

/**
 * One-off, run right after P1-05 is deployed (npm run artisans:backfill).
 *
 * Artisans made before P1-05 by "create an artisan" or by approving an application
 * have an account and NO profile: the assignment refuses them ("profil artisan
 * introuvable"). And approved profiles made by hand or approved from a pending
 * review were left on "not accepting missions", which the assignment refuses too.
 *
 *  - an active ARTISAN account with no profile gets an APPROVED profile that
 *    accepts missions: the back office made or approved that account itself (the
 *    self-service sign-up always makes a profile, and starts it pending);
 *  - an inactive or deleted account with no profile is only listed: giving it an
 *    approved profile would approve it the day somebody switches the account on;
 *  - an APPROVED profile that does not accept missions is only listed, and switched
 *    on only with `switchOn`: an artisan may have turned it off on purpose;
 *  - an APPROVED profile of an active account that is not available for urgent jobs
 *    is only listed, and switched on only with `emergencyOn`: until now no route could
 *    set that flag, so every profile made before has it off, and the assignment
 *    refuses an urgent job for such an artisan (the admin screen used to accept any
 *    approved artisan). From now on the artisan or the back office can turn it off, and
 *    the script cannot tell "never set" from "turned off on purpose": run it ONCE
 *    with `emergencyOn`, never again, or it switches those back on.
 *
 * Nothing is deleted. A profile that exists is changed only with `switchOn` (missions)
 * or `emergencyOn` (urgent jobs), and only the flag named.
 */
export type BackfillOptions = {
  apply: boolean;
  /** Also switch missions on for approved profiles that do not accept them. */
  switchOn: boolean;
  /** Also make approved profiles available for urgent jobs (once: see above). */
  emergencyOn: boolean;
};

export type BackfillReport = {
  /** Active artisan accounts with no profile. */
  withoutProfile: number[];
  /** Inactive or deleted artisan accounts with no profile: left alone. */
  withoutProfileInactive: number[];
  /** Approved profiles of active accounts that do not accept missions (user ids). */
  notAccepting: number[];
  /** Approved profiles of active accounts that are not available for urgent jobs (user ids). */
  noEmergency: number[];
  created: number[];
  switchedOn: number[];
  /** Profiles now available for urgent jobs. */
  emergencyOn: number[];
  /** A profile appeared (or an account changed) while the script ran: left as it is. */
  raced: number[];
};

type Db = {
  user: { findMany: (args: any) => Promise<any[]> };
  artisanProfile: {
    findMany: (args: any) => Promise<any[]>;
    create: (args: any) => Promise<any>;
    updateMany: (args: any) => Promise<{ count: number }>;
  };
};

export async function backfillArtisanProfiles(db: Db, options: BackfillOptions): Promise<BackfillReport> {
  const [artisans, profiles] = await Promise.all([
    db.user.findMany({
      where: { role: Role.ARTISAN },
      select: { id: true, isActive: true, deletedAt: true },
      orderBy: { id: 'asc' },
    }),
    db.artisanProfile.findMany({
      select: { id: true, userId: true, verificationStatus: true, isAcceptingJobs: true, emergencyAvailable: true },
    }),
  ]);

  const profileOf = new Map<number, { id: number; verificationStatus: string; isAcceptingJobs: boolean; emergencyAvailable: boolean }>(
    profiles.map((profile) => [profile.userId, profile]),
  );
  const isLive = (user: { isActive: boolean; deletedAt: Date | null }) => user.isActive && !user.deletedAt;

  const report: BackfillReport = {
    withoutProfile: [],
    withoutProfileInactive: [],
    notAccepting: [],
    noEmergency: [],
    created: [],
    switchedOn: [],
    emergencyOn: [],
    raced: [],
  };

  for (const artisan of artisans) {
    const profile = profileOf.get(artisan.id);

    if (!profile) {
      (isLive(artisan) ? report.withoutProfile : report.withoutProfileInactive).push(artisan.id);
      continue;
    }

    if (isLive(artisan) && profile.verificationStatus === ArtisanVerificationStatus.APPROVED) {
      if (!profile.isAcceptingJobs) report.notAccepting.push(artisan.id);
      if (!profile.emergencyAvailable) report.noEmergency.push(artisan.id);
    }
  }

  if (!options.apply) return report;

  for (const userId of report.withoutProfile) {
    try {
      await db.artisanProfile.create({ data: approvedProfileData({ userId }) });
      report.created.push(userId);
    } catch (error: any) {
      // Unique on userId: somebody made the profile since the read.
      if (error?.code === 'P2002') {
        report.raced.push(userId);
        continue;
      }

      throw error;
    }
  }

  if (options.emergencyOn) {
    for (const userId of report.noEmergency) {
      // Only if it is still approved and still off: a suspension made while this ran stays.
      const done = await db.artisanProfile.updateMany({
        where: { userId, verificationStatus: ArtisanVerificationStatus.APPROVED, emergencyAvailable: false },
        data: { emergencyAvailable: true },
      });

      if (done.count === 1) report.emergencyOn.push(userId);
      else report.raced.push(userId);
    }
  }

  if (options.switchOn) {
    for (const userId of report.notAccepting) {
      // Only if it is still approved and still off: a suspension made while this ran stays.
      const done = await db.artisanProfile.updateMany({
        where: { userId, verificationStatus: ArtisanVerificationStatus.APPROVED, isAcceptingJobs: false },
        data: { isAcceptingJobs: true },
      });

      if (done.count === 1) report.switchedOn.push(userId);
      else report.raced.push(userId);
    }
  }

  return report;
}
