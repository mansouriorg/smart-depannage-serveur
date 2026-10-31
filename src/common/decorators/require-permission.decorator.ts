import { SetMetadata } from '@nestjs/common';

import { Permission } from '../auth/permissions';

export const PERMISSION_KEY = 'permission';

/**
 * The permission a route needs (P3-02). Which roles hold it is said in one place, `common/auth/permissions.ts`;
 * `PermissionsGuard` (in the `@UseGuards` of the controller or the route) turns away a caller whose role does not hold it.
 */
export const RequirePermission = (permission: Permission) => SetMetadata(PERMISSION_KEY, permission);
