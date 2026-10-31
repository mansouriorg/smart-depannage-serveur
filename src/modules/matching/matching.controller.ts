import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { MatchingService } from './matching.service';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Permission } from '../../common/auth/permissions';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

import { Role } from '../../../generated/prisma/client';

import {
  AssignMatchedArtisanDto,
  MatchArtisansQueryDto,
} from './dto/matching.dto';

// The matches (who could take this job, with a score and an arrival time) are for the people who give
// jobs to artisans: the roles of the admin route for it (P1-13). Support and accountants could look at
// the matches and give a job through these routes before, although the admin route
// (POST /admin/interventions/:id/assign-artisan) never let them.
@Controller('matching')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class MatchingController {
  constructor(private readonly service: MatchingService) {}

  // ==========================================================
  // Admin dashboard: match artisans for a specific intervention
  // ==========================================================

  /**
   * GET /matching/admin/interventions/:interventionId/artisans
   *
   * Optional query:
   * ?startsAt=2026-06-28T09:00:00.000Z
   * &endsAt=2026-06-28T11:00:00.000Z
   * &onlyAvailable=true
   * &limit=10
   */
  @RequirePermission(Permission.TICKETS_DISPATCH)
  @Get('admin/interventions/:interventionId/artisans')
  findMatchingArtisansForIntervention(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('interventionId', ParseIntPipe) interventionId: number,
    @Query() query: MatchArtisansQueryDto,
  ) {
    return this.service.findMatchingArtisansForIntervention(
      userId,
      role,
      interventionId,
      query,
    );
  }

  // ==========================================================
  // Admin dashboard: generic artisan matching
  // ==========================================================

  /**
   * GET /matching/admin/artisans
   *
   * Required:
   * ?serviceType=PLOMBIER
   *
   * Optional:
   * &latitude=48.8566
   * &longitude=2.3522
   * &startsAt=2026-06-28T09:00:00.000Z
   * &endsAt=2026-06-28T11:00:00.000Z
   * &emergency=true
   * &onlyAvailable=true
   * &limit=10
   */
  @RequirePermission(Permission.TICKETS_DISPATCH)
  @Get('admin/artisans')
  findMatchingArtisans(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Query() query: MatchArtisansQueryDto,
  ) {
    return this.service.findMatchingArtisans(
      userId,
      role,
      query,
    );
  }

  // ==========================================================
  // Admin: assign best available artisan
  // ==========================================================

  /**
   * POST /matching/admin/interventions/:interventionId/assign-best
   *
   * Body optional:
   * {
   *   "startsAt": "2026-06-28T09:00:00.000Z",
   *   "endsAt": "2026-06-28T11:00:00.000Z",
   *   "adminNote": "Assigned from smart matching"
   * }
   */
  @RequirePermission(Permission.TICKETS_DISPATCH)
  @Post('admin/interventions/:interventionId/assign-best')
  assignBestArtisan(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('interventionId', ParseIntPipe) interventionId: number,
    @Body() dto: AssignMatchedArtisanDto,
  ) {
    return this.service.assignBestArtisan(
      userId,
      role,
      interventionId,
      dto,
    );
  }

  // ==========================================================
  // Admin: assign selected artisan from matching result
  // ==========================================================

  /**
   * POST /matching/admin/interventions/:interventionId/assign/:artisanId
   *
   * Body optional:
   * {
   *   "startsAt": "2026-06-28T09:00:00.000Z",
   *   "endsAt": "2026-06-28T11:00:00.000Z",
   *   "adminNote": "Manual choice from smart matching"
   * }
   */
  @RequirePermission(Permission.TICKETS_DISPATCH)
  @Post('admin/interventions/:interventionId/assign/:artisanId')
  assignArtisan(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('interventionId', ParseIntPipe) interventionId: number,
    @Param('artisanId', ParseIntPipe) artisanId: number,
    @Body() dto: AssignMatchedArtisanDto,
  ) {
    return this.service.assignArtisan(
      userId,
      role,
      interventionId,
      artisanId,
      dto,
    );
  }
}
