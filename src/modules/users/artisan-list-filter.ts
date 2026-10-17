import { ArtisanVerificationStatus, Role } from '../../../generated/prisma/client';

/** The most artisans one page of the list may hold (a dropdown needs them all at once, not a million). */
export const MAX_ARTISAN_PAGE_SIZE = 200;
export const DEFAULT_ARTISAN_PAGE_SIZE = 50;

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
