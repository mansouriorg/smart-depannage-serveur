import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { Permission, can } from '../auth/permissions';
import { PERMISSION_KEY } from '../decorators/require-permission.decorator';
import { AuthenticatedUser } from '../../modules/auth/types/authenticated-user.type';

/**
 * Lets in the roles that hold the permission the route names (P3-02). The permission of the route wins over the
 * one of the controller. A route that names none is refused: a guard that was put on a route is there to keep
 * somebody out, and a forgotten `@RequirePermission` must not turn it into an open door (the old `@Roles` guard
 * let such a route through). A route that every signed-in account may call does not use this guard.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const needed = this.reflector.getAllAndOverride<Permission | undefined>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest();
    const user = request.user as AuthenticatedUser;

    if (!user) {
      throw new ForbiddenException('Utilisateur non authentifié.');
    }

    if (!needed || !can(user.role, needed)) {
      throw new ForbiddenException('Accès refusé.');
    }

    return true;
  }
}
