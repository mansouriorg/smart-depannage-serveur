import { Role } from '../../../generated/prisma/client';

/**
 * Role rules shared by controllers, services and gateways (P0-05, P0-08).
 * Keep every "who is allowed" decision here instead of repeating
 * `role === 'ADMIN'` in each controller.
 */

/** Staff who work on tickets: see every ticket, assign artisans, change status. */
export const TICKET_STAFF_ROLES: Role[] = [
  Role.ADMIN,
  Role.SUPER_ADMIN,
  Role.SUPPORT,
  Role.DISPATCHER,
];

/** Every role that belongs to the back office. */
export const BACK_OFFICE_ROLES: Role[] = [
  ...TICKET_STAFF_ROLES,
  Role.ACCOUNTANT,
];

export function isTicketStaff(role: Role | string | undefined | null): boolean {
  return TICKET_STAFF_ROLES.includes(role as Role);
}

export function isBackOffice(role: Role | string | undefined | null): boolean {
  return BACK_OFFICE_ROLES.includes(role as Role);
}

/**
 * Hierarchy used to decide who may act on whom. Higher rank = more power.
 * Customers and artisans are "outside" accounts and share the lowest rank.
 */
const ROLE_RANK: Record<Role, number> = {
  [Role.CLIENT]: 0,
  [Role.ARTISAN]: 0,
  [Role.ACCOUNTANT]: 1,
  [Role.SUPPORT]: 1,
  [Role.DISPATCHER]: 1,
  [Role.ADMIN]: 2,
  [Role.SUPER_ADMIN]: 3,
};

export function roleRank(role: Role): number {
  return ROLE_RANK[role] ?? 0;
}

/**
 * Can `actor` change (edit, deactivate, delete, reset the password of) an
 * account that has `targetRole`, and optionally give it `newRole`?
 *
 *  - SUPER_ADMIN can manage everyone;
 *  - everybody else can only manage accounts of a strictly lower rank, and
 *    can only hand out roles of a strictly lower rank than their own.
 *
 * So an ADMIN cannot touch a SUPER_ADMIN or another ADMIN, and cannot promote
 * anyone to ADMIN or SUPER_ADMIN.
 */
export function canManage(
  actorRole: Role,
  targetRole: Role,
  newRole?: Role,
): boolean {
  if (actorRole === Role.SUPER_ADMIN) {
    return true;
  }

  if (roleRank(actorRole) <= roleRank(targetRole)) {
    return false;
  }

  if (newRole !== undefined && roleRank(actorRole) <= roleRank(newRole)) {
    return false;
  }

  return true;
}
