import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { InterventionWorkflowService } from './intervention-workflow.service';

import { ChangeWorkflowStatusDto } from './dto/change-workflow-status.dto';
import { CreateTimelineEventDto } from './dto/create-timeline-event.dto';
import { PublicTimelineQueryDto } from './dto/public-timeline-query.dto';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Permission } from '../../common/auth/permissions';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

import { Role } from '../../../generated/prisma/client';

@Controller('interventions')
export class InterventionWorkflowController {
  constructor(
    private readonly workflowService: InterventionWorkflowService,
  ) {}

  // ==========================================================
  // AUTHENTICATED TIMELINE
  // Admin / client / artisan
  // ==========================================================

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.WORKFLOW_TIMELINE)
  @Get(':id/timeline')
  getTimeline(
    @CurrentUser() user: { id: number; role: Role },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.workflowService.getTimeline(user, id);
  }

  // ==========================================================
  // PUBLIC TRACKING TIMELINE
  // For guest / public tracking page
  // GET /interventions/public/:id/timeline?token=RAW_TOKEN
  // ==========================================================

  @Get('public/:id/timeline')
  getPublicTimeline(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: PublicTimelineQueryDto,
  ) {
    return this.workflowService.getPublicTimeline(id, query.token);
  }

  // ==========================================================
  // WHAT CAN HAPPEN NEXT
  // The statuses the caller may move this job to right now. Buttons and
  // dropdowns in the apps offer exactly these (P1-01).
  // ==========================================================

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.WORKFLOW_NEXT_STATUSES)
  @Get(':id/workflow/next-statuses')
  getNextStatuses(
    @CurrentUser() user: { id: number; role: Role },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.workflowService.getNextStatuses(user, id);
  }

  // ==========================================================
  // ADMIN STATUS TRANSITION
  // ==========================================================

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.TICKETS_WORKFLOW)
  @Patch(':id/workflow/status')
  changeStatus(
    @CurrentUser() user: { id: number; role: Role },
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ChangeWorkflowStatusDto,
  ) {
    return this.workflowService.changeStatus(user, id, dto);
  }

  // ==========================================================
  // ADMIN MANUAL TIMELINE EVENT
  // ==========================================================

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.TICKETS_WORKFLOW)
  @Post(':id/workflow/events')
  createManualTimelineEvent(
    @CurrentUser() user: { id: number; role: Role },
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateTimelineEventDto,
  ) {
    return this.workflowService.createManualTimelineEvent(user, id, dto);
  }
}
