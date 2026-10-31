import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { Permission } from '../../common/auth/permissions';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { parseAuditQuery } from './audit-query';
import { AuditService } from './audit.service';

/** The audit log of the back office (P3-02): who did what to which thing, and when. Reading only; nothing writes here but the interceptor. */
@Controller('admin/audit-log')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AuditController {
  constructor(private readonly service: AuditService) {}

  /**
   * A page of the log, newest first.
   *
   * GET /admin/audit-log?action=users.&actorId=3&outcome=SUCCEEDED&from=2026-10-01&limit=50&before=1200
   */
  @RequirePermission(Permission.AUDIT_READ)
  @Get()
  list(@Query() query: Record<string, unknown>) {
    return this.service.list(parseAuditQuery(query));
  }
}
