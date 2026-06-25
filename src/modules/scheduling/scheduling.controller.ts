import {
  Body,
  Controller,
  Get,
  Param,
  ParseBoolPipe,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { SchedulingService } from './scheduling.service';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

import { Role } from '../../../generated/prisma/client';

import {
  CalendarQueryDto,
  CancelAppointmentRequestDto,
  CreateTimeBlockDto,
  PreferredTimeDto,
  RescheduleRequestDto,
  ReviewAppointmentRequestDto,
  ScheduleInterventionDto,
  UpdateAvailabilitySlotDto,
} from './dto/scheduling.dto';

@Controller('scheduling')
@UseGuards(JwtAuthGuard)
export class SchedulingController {
  constructor(private readonly service: SchedulingService) {}

  // ==========================================================
  // Client side
  // ==========================================================

  @Post('interventions/:interventionId/preferred-time')
  choosePreferredTime(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('interventionId', ParseIntPipe) interventionId: number,
    @Body() dto: PreferredTimeDto,
  ) {
    return this.service.choosePreferredTime(
      userId,
      role,
      interventionId,
      dto,
    );
  }

  @Get('interventions/:interventionId/appointment')
  getAppointmentForIntervention(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('interventionId', ParseIntPipe) interventionId: number,
  ) {
    return this.service.getAppointmentForIntervention(
      userId,
      role,
      interventionId,
    );
  }

  @Post('appointments/:appointmentId/reschedule-request')
  requestReschedule(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('appointmentId', ParseIntPipe) appointmentId: number,
    @Body() dto: RescheduleRequestDto,
  ) {
    return this.service.requestReschedule(
      userId,
      role,
      appointmentId,
      dto,
    );
  }

  @Post('appointments/:appointmentId/cancel-request')
  requestCancel(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('appointmentId', ParseIntPipe) appointmentId: number,
    @Body() dto: CancelAppointmentRequestDto,
  ) {
    return this.service.requestCancel(
      userId,
      role,
      appointmentId,
      dto,
    );
  }

  // ==========================================================
  // Admin side
  // ==========================================================

  @Post('admin/interventions/:interventionId/schedule')
  scheduleIntervention(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('interventionId', ParseIntPipe) interventionId: number,
    @Body() dto: ScheduleInterventionDto,
  ) {
    return this.service.scheduleIntervention(
      userId,
      role,
      interventionId,
      dto,
    );
  }

  @Get('admin/calendar')
  getAdminCalendar(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Query() query: CalendarQueryDto,
  ) {
    return this.service.getAdminCalendar(
      userId,
      role,
      query.from,
      query.to,
      query.artisanId,
    );
  }

  @Get('admin/artisans/:artisanId/availability')
  getArtisanAvailability(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('artisanId', ParseIntPipe) artisanId: number,
    @Query('date') date?: string,
  ) {
    return this.service.getArtisanAvailability(
      userId,
      role,
      artisanId,
      date,
    );
  }

  @Patch('admin/requests/:requestId/review')
  reviewAppointmentRequest(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('requestId', ParseIntPipe) requestId: number,
    @Query('approved', ParseBoolPipe) approved: boolean,
    @Body() dto: ReviewAppointmentRequestDto,
  ) {
    return this.service.reviewAppointmentRequest(
      userId,
      role,
      requestId,
      approved,
      dto,
    );
  }

  // ==========================================================
  // Artisan side
  // ==========================================================

  @Get('artisan/daily')
  getArtisanDailySchedule(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Query('date') date: string,
    @Query('artisanId') artisanId?: string,
  ) {
    return this.service.getArtisanDailySchedule(
      userId,
      role,
      date,
      artisanId ? Number(artisanId) : undefined,
    );
  }

  @Patch('artisan/appointments/:appointmentId/accept')
  acceptScheduledMission(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('appointmentId', ParseIntPipe) appointmentId: number,
  ) {
    return this.service.acceptScheduledMission(
      userId,
      role,
      appointmentId,
    );
  }

  @Post('artisan/availability')
  upsertAvailabilitySlot(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Body() dto: UpdateAvailabilitySlotDto,
  ) {
    return this.service.upsertAvailabilitySlot(
      userId,
      role,
      dto,
    );
  }

  @Post('artisan/time-blocks')
  createTimeBlock(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Body() dto: CreateTimeBlockDto,
  ) {
    return this.service.createTimeBlock(
      userId,
      role,
      dto,
    );
  }

  @Get('artisan/time-blocks')
  listMyTimeBlocks(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.service.listMyTimeBlocks(
      userId,
      role,
      from,
      to,
    );
  }
}