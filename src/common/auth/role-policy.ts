import { Role } from '../../../generated/prisma/client';

import { Permission, can, rolesWith } from './permissions';

/**
 * Role rules shared by controllers, services and gateways (P0-05, P0-08).
 * Which roles may do what is the matrix of `permissions.ts` (P3-02); this file keeps what is not a
 * permission: the hierarchy (who may act on whom).
 */

/**
 * Staff who work on tickets: see every ticket, assign artisans, change status. Not a list of its own: the roles
 * that hold `tickets.read` in the matrix (`permissions.ts`).
 */
export const TICKET_STAFF_ROLES: Role[] = rolesWith(Permission.TICKETS_READ);

/** Every role that belongs to the back office: the roles that hold `back-office.access`. */
export const BACK_OFFICE_ROLES: Role[] = rolesWith(Permission.BACK_OFFICE_ACCESS);

export function isTicketStaff(role: Role | string | undefined | null): boolean {
  return can(role, Permission.TICKETS_READ);
}

export function isBackOffice(role: Role | string | undefined | null): boolean {
  return can(role, Permission.BACK_OFFICE_ACCESS);
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
