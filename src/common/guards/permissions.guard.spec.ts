import { ExecutionContext, ForbiddenException } from '@nestjs/common';

import { Role } from '../../../generated/prisma/client';
import { Permission } from '../auth/permissions';
import { PERMISSION_KEY } from '../decorators/require-permission.decorator';
import { PermissionsGuard } from './permissions.guard';

/**
 * The guard that checks the permission a route names (P3-02), driven with a reflector that reads `getAllAndOverride` the way Nest does:
 * the first target of the list that has a value wins.
 */

const handler = function routeMethod() {};
class Controller {}

/** What `@RequirePermission` stored on the method and on the class. */
function reflectorWith(stored: { handler?: Permission; controller?: Permission }) {
  return {
    getAllAndOverride: (key: string, targets: unknown[]) => {
      if (key !== PERMISSION_KEY) return undefined;

      for (const target of targets) {
        const value = target === handler ? stored.handler : target === Controller ? stored.controller : undefined;

        if (value !== undefined) return value;
      }

      return undefined;
    },
  } as any;
}

function contextOf(user: unknown): ExecutionContext {
  return { getHandler: () => handler, getClass: () => Controller, switchToHttp: () => ({ getRequest: () => ({ user }) }) } as unknown as ExecutionContext;
}

/** Whether the guard lets the call in; a refusal is a 403 with its message. */
function verdict(guard: PermissionsGuard, user: unknown): string {
  try {
    return guard.canActivate(contextOf(user)) ? 'in' : 'out';
  } catch (error) {
    return error instanceof ForbiddenException ? `403 ${(error as ForbiddenException).message}` : `error ${String(error)}`;
  }
}

describe('the guard of the permission (P3-02)', () => {
  it('lets in the roles that hold the permission of the route and refuses the others, in French, with a 403', () => {
    const guard = new PermissionsGuard(reflectorWith({ handler: Permission.USERS_MANAGE }));

    expect(verdict(guard, { id: 1, role: Role.ADMIN })).toBe('in');
    expect(verdict(guard, { id: 1, role: Role.SUPER_ADMIN })).toBe('in');

    for (const role of [Role.SUPPORT, Role.DISPATCHER, Role.ACCOUNTANT, Role.CLIENT, Role.ARTISAN]) {
      expect([role, verdict(guard, { id: 1, role })]).toEqual([role, '403 Accès refusé.']);
    }
  });

  it('refuses a role it does not know, and a user without a role', () => {
    const guard = new PermissionsGuard(reflectorWith({ handler: Permission.USERS_MANAGE }));

    expect(verdict(guard, { id: 1, role: 'ROOT' })).toBe('403 Accès refusé.');
    expect(verdict(guard, { id: 1 })).toBe('403 Accès refusé.');
  });

  it('refuses a call without a signed-in person', () => {
    const guard = new PermissionsGuard(reflectorWith({ handler: Permission.USERS_MANAGE }));

    expect(verdict(guard, undefined)).toBe('403 Utilisateur non authentifié.');
    expect(verdict(guard, null)).toBe('403 Utilisateur non authentifié.');
  });

  it('the permission of the route wins over the one of the controller', () => {
    const guard = new PermissionsGuard(reflectorWith({ handler: Permission.AUDIT_READ, controller: Permission.USERS_READ }));

    // ACCOUNTANT holds neither of the two, SUPPORT holds the controller's but not the route's.
    expect(verdict(guard, { id: 1, role: Role.SUPPORT })).toBe('403 Accès refusé.');
    expect(verdict(guard, { id: 1, role: Role.ADMIN })).toBe('in');
  });

  it('a route that names nothing takes the permission of its controller', () => {
    const guard = new PermissionsGuard(reflectorWith({ controller: Permission.AUDIT_READ }));

    expect(verdict(guard, { id: 1, role: Role.ADMIN })).toBe('in');
    expect(verdict(guard, { id: 1, role: Role.SUPPORT })).toBe('403 Accès refusé.');
  });

  it('a route that names no permission at all is refused, whoever calls it: a forgotten decorator is not an open door', () => {
    const guard = new PermissionsGuard(reflectorWith({}));

    for (const role of [Role.SUPER_ADMIN, Role.ADMIN, Role.SUPPORT, Role.DISPATCHER, Role.ACCOUNTANT, Role.CLIENT, Role.ARTISAN]) {
      expect([role, verdict(guard, { id: 1, role })]).toEqual([role, '403 Accès refusé.']);
    }

    expect(verdict(guard, undefined)).toBe('403 Utilisateur non authentifié.');
  });

  it('a route that names something that is not a permission of the matrix is refused as well', () => {
    for (const named of ['users.destroy', 'constructor', '__proto__', '']) {
      const guard = new PermissionsGuard(reflectorWith({ handler: named as unknown as Permission }));

      expect([named, verdict(guard, { id: 1, role: Role.SUPER_ADMIN })]).toEqual([named, '403 Accès refusé.']);
    }
  });

  it('looks for the permission under the key the decorator writes', () => {
    expect(PERMISSION_KEY).toBe('permission');
  });
});
