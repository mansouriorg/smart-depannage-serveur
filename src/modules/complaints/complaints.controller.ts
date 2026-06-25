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

import { ComplaintsService } from './complaints.service';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

import { Role } from '../../../generated/prisma/client';

import {
  AddComplaintMessageDto,
  AdminComplaintDecisionDto,
  ArtisanResponseDto,
  AssignComplaintDto,
  ComplaintQueryDto,
  CreateComplaintDto,
  RefundDecisionDto,
  ResolveComplaintDto,
  UpdateComplaintStatusDto,
} from './dto/complaint.dto';

@Controller('complaints')
@UseGuards(JwtAuthGuard)
export class ComplaintsController {
  constructor(private readonly service: ComplaintsService) {}

  // ==========================================================
  // Client / Artisan: create complaint
  // ==========================================================

  /**
   * POST /complaints/interventions/:interventionId
   */
  @Post('interventions/:interventionId')
  createComplaint(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('interventionId', ParseIntPipe) interventionId: number,
    @Body() dto: CreateComplaintDto,
  ) {
    return this.service.createComplaint(
      userId,
      role,
      interventionId,
      dto,
    );
  }

  // ==========================================================
  // Current user complaints
  // ==========================================================

  /**
   * GET /complaints/me
   */
  @Get('me')
  findMyComplaints(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
  ) {
    return this.service.findMyComplaints(userId, role);
  }

  // ==========================================================
  // Complaints by intervention
  // ==========================================================

  /**
   * GET /complaints/interventions/:interventionId
   */
  @Get('interventions/:interventionId')
  findByIntervention(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('interventionId', ParseIntPipe) interventionId: number,
  ) {
    return this.service.findByIntervention(
      userId,
      role,
      interventionId,
    );
  }

  // ==========================================================
  // Admin routes
  // Must stay before GET /complaints/:complaintId
  // ==========================================================

  /**
   * GET /complaints/admin
   */
  @Get('admin')
  adminFindAll(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Query() query: ComplaintQueryDto,
  ) {
    return this.service.adminFindAll(userId, role, query);
  }

  /**
   * GET /complaints/admin/dashboard
   */
  @Get('admin/dashboard')
  adminDashboard(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
  ) {
    return this.service.adminDashboard(userId, role);
  }

  /**
   * PATCH /complaints/admin/:complaintId/assign
   */
  @Patch('admin/:complaintId/assign')
  assignComplaint(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('complaintId', ParseIntPipe) complaintId: number,
    @Body() dto: AssignComplaintDto,
  ) {
    return this.service.assignComplaint(
      userId,
      role,
      complaintId,
      dto,
    );
  }

  /**
   * PATCH /complaints/admin/:complaintId/status
   */
  @Patch('admin/:complaintId/status')
  updateStatus(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('complaintId', ParseIntPipe) complaintId: number,
    @Body() dto: UpdateComplaintStatusDto,
  ) {
    return this.service.updateStatus(
      userId,
      role,
      complaintId,
      dto,
    );
  }

  /**
   * PATCH /complaints/admin/:complaintId/decision
   */
  @Patch('admin/:complaintId/decision')
  adminDecision(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('complaintId', ParseIntPipe) complaintId: number,
    @Body() dto: AdminComplaintDecisionDto,
  ) {
    return this.service.adminDecision(
      userId,
      role,
      complaintId,
      dto,
    );
  }

  /**
   * PATCH /complaints/admin/:complaintId/refund
   */
  @Patch('admin/:complaintId/refund')
  refundDecision(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('complaintId', ParseIntPipe) complaintId: number,
    @Body() dto: RefundDecisionDto,
  ) {
    return this.service.refundDecision(
      userId,
      role,
      complaintId,
      dto,
    );
  }

  /**
   * PATCH /complaints/admin/:complaintId/resolve
   */
  @Patch('admin/:complaintId/resolve')
  resolveComplaint(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('complaintId', ParseIntPipe) complaintId: number,
    @Body() dto: ResolveComplaintDto,
  ) {
    return this.service.resolveComplaint(
      userId,
      role,
      complaintId,
      dto,
    );
  }

  // ==========================================================
  // Complaint discussion
  // ==========================================================

  /**
   * POST /complaints/:complaintId/messages
   */
  @Post(':complaintId/messages')
  addMessage(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('complaintId', ParseIntPipe) complaintId: number,
    @Body() dto: AddComplaintMessageDto,
  ) {
    return this.service.addMessage(
      userId,
      role,
      complaintId,
      dto,
    );
  }

  /**
   * POST /complaints/:complaintId/artisan-response
   */
  @Post(':complaintId/artisan-response')
  artisanResponse(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('complaintId', ParseIntPipe) complaintId: number,
    @Body() dto: ArtisanResponseDto,
  ) {
    return this.service.artisanResponse(
      userId,
      role,
      complaintId,
      dto,
    );
  }

  // ==========================================================
  // Complaint detail
  // Must stay after specific routes
  // ==========================================================

  /**
   * GET /complaints/:complaintId
   */
  @Get(':complaintId')
  findOne(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('complaintId', ParseIntPipe) complaintId: number,
  ) {
    return this.service.findOne(
      userId,
      role,
      complaintId,
    );
  }
}