import { ArtisanVerificationStatus } from '../../../generated/prisma/client';

/**
 * The profile of an artisan the back office created or approved itself (P1-05).
 *
 * An assignment needs an APPROVED profile that accepts missions. Three ways of making
 * an artisan used to leave that out: "create an artisan" and "approve an application"
 * made an account with no profile at all, and "create an artisan manually" made an
 * approved profile that did not accept missions (the schema default is "no", and the
 * mobile app has no switch for it). Those artisans could not be given a job. Now the
 * person who approves an artisan gets one who can be given a job; the artisan can
 * still switch missions off, and an admin can suspend the account.
 *
 * Urgent jobs are on too. Nothing in the application could ever set that flag (the
 * schema default is "no" and no route wrote it), so leaving it off would make every
 * urgent job impossible to assign, where the admin screen used to accept any approved
 * artisan. The artisan and the back office can now turn it off (PATCH of the profile).
 */
export function approvedProfileData(fields: {
  userId: number;
  specialty?: string | null;
  specialties?: string[] | null;
  yearsExperience?: number | null;
  bio?: string | null;
  verifiedById?: number | null;
}) {
  return {
    userId: fields.userId,
    specialty: fields.specialty ?? undefined,
    specialties: fields.specialties ?? (fields.specialty ? [fields.specialty] : undefined),
    yearsExperience: fields.yearsExperience ?? undefined,
    bio: fields.bio ?? undefined,
    verificationStatus: ArtisanVerificationStatus.APPROVED,
    verifiedAt: new Date(),
    verifiedById: fields.verifiedById ?? undefined,
    isAcceptingJobs: true,
    emergencyAvailable: true,
  };
}
