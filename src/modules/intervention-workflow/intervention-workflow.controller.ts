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
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
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

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    Role.CLIENT,
    Role.ARTISAN,
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
    Role.ACCOUNTANT,
  )
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
  // ADMIN STATUS TRANSITION
  // ==========================================================

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.SUPPORT, Role.DISPATCHER)
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

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.SUPPORT, Role.DISPATCHER)
  @Post(':id/workflow/events')
  createManualTimelineEvent(
    @CurrentUser() user: { id: number; role: Role },
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateTimelineEventDto,
  ) {
    return this.workflowService.createManualTimelineEvent(user, id, dto);
  }
}