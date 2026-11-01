import { ArtisanVerificationStatus, Role } from '../../../generated/prisma/client';

/** The most artisans one page of the list may hold (a dropdown needs them all at once, not a million). */
export const MAX_ARTISAN_PAGE_SIZE = 200;
export const DEFAULT_ARTISAN_PAGE_SIZE = 50;

/**
 * What the technicians page shows of an artisan's profile besides the account (P1-12): the trade and
 * the real rating. The page showed "5.0" for everybody because the list carried no rating at all.
 */
export const ARTISAN_LIST_PROFILE_SELECT = {
  specialty: true,
  averageRating: true,
  ratingCount: true,
  // ONLINE, BUSY or OFFLINE: the phone sends its position only when the technician is at work, so "no news" is an alarm for those and not for the others (P3-05).
  availabilityStatus: true,
} as const;

/**
 * What customers answered after the jobs of an artisan (the rating from the tracking link): the
 * average, rounded to two decimals like the profile's, and how many answered. `average` is null when
 * nobody did.
 */
export function artisanFeedback(
  average: number | null | undefined,
  count: number | null | undefined,
): { average: number | null; count: number } {
  const answers = Number(count ?? 0);

  if (!Number.isFinite(answers) || answers < 1 || average === null || average === undefined || !Number.isFinite(Number(average))) {
    return { average: null, count: 0 };
  }

  return { average: Number(Number(average).toFixed(2)), count: answers };
}

/** `?assignable=true`, `?assignable=1`: the query string is text. */
export function isTruthyFlag(value: unknown): boolean {
  return value === true || (typeof value === 'string' && ['true', '1'].includes(value.trim().toLowerCase()));
}

/**
 * Which artisans GET /users/artisans lists (P1-05). With `assignable` only the ones a
 * job can be given to (an active account whose application was approved): the dropdown
 * of the dashboard asks for this, so an unapproved artisan is not offered. The technicians
 * page asks for everybody, to be able to approve them.
 */
export function artisanListWhere(params: { search?: string; assignable?: unknown }): Record<string, unknown> {
  const where: Record<string, unknown> = {
    role: Role.ARTISAN,
    deletedAt: null,
  };

  if (isTruthyFlag(params.assignable)) {
    where.isActive = true;
    where.artisanProfile = { is: { verificationStatus: ArtisanVerificationStatus.APPROVED } };
  }

  if (params.search) {
    where.OR = [
      { email: { contains: params.search, mode: 'insensitive' } },
      { name: { contains: params.search, mode: 'insensitive' } },
      { phone: { contains: params.search, mode: 'insensitive' } },
    ];
  }

  return where;
}

/** 1 to 200, 50 when absent or not a number. */
export function artisanPageSize(limit?: string): number {
  const asked = Number(limit);

  if (!limit || !Number.isFinite(asked) || asked < 1) return DEFAULT_ARTISAN_PAGE_SIZE;

  return Math.min(Math.floor(asked), MAX_ARTISAN_PAGE_SIZE);
}
