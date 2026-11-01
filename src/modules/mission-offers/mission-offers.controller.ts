import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';

import { Permission } from '../../common/auth/permissions';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { Role } from '../../../generated/prisma/client';

import { MissionOffersService } from './mission-offers.service';

/**
 * A job offered to several technicians at once (P3-07). The back office offers an open job, looks at the offers of a job and calls them off;
 * the technician reads the offers made to them. Answering an offer is not a route of its own: the technician accepts or refuses the job like
 * any open job (`POST /artisans/me/missions/:id/accept` and `/reject`), and the offer follows the answer.
 */
@Controller()
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class MissionOffersController {
  constructor(private readonly service: MissionOffersService) {}

  // The body is read by the service (`offerRequest`), which says what is wrong in the words of the dispatcher: a plain object type (not a class), so that
  // the global pipe does not answer first with its own sentence.
  @RequirePermission(Permission.TICKETS_DISPATCH)
  @Post('admin/interventions/:id/offers')
  send(
    @CurrentUser('id') adminId: number,
    @CurrentUser('role') role: Role,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { count?: unknown; minutes?: unknown },
  ) {
    return this.service.send({ id: adminId, role }, id, body);
  }

  @RequirePermission(Permission.TICKETS_READ)
  @Get('admin/interventions/:id/offers')
  list(@Param('id', ParseIntPipe) id: number) {
    return this.service.listForJob(id);
  }

  @RequirePermission(Permission.TICKETS_DISPATCH)
  @Delete('admin/interventions/:id/offers')
  withdraw(@CurrentUser('id') adminId: number, @Param('id', ParseIntPipe) id: number) {
    return this.service.withdrawRound(adminId, id);
  }

  @RequirePermission(Permission.MISSIONS_WORK)
  @Get('artisans/me/offers')
  mine(@CurrentUser('id') userId: number) {
    return this.service.listMine(userId);
  }
}
