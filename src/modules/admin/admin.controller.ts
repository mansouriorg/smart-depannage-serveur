import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { AdminService } from './admin.service';

import {
  AdminContactDto,
  AdminInternalNoteDto,
  AdminInterventionQueryDto,
  AdminArtisanQueryDto,
  AdminClientQueryDto,
  AdminComplaintQueryDto,
  AdminApproveArtisanDto,
  AdminRejectArtisanDto,
  AdminReviewArtisanDto,
  AdminSendQuoteDto,
  AssignArtisanDto,
  AssignComplaintDto,
  CancelInterventionDto,
  ChangeInterventionStatusDto,
  CreateAdminServiceZoneDto,
  CreateArtisanManualDto,
  CreateNotificationTemplateDto,
  DashboardQueryDto,
  DecideRefundDto,
  EditArtisanProfileDto,
  EditClientDto,
  UpdateAdminServiceZoneDto,
  UpdateCompanySettingsDto,
  UpdateComplaintStatusDto,
  UpdateNotificationTemplateDto,
  UpdateServiceCategoryPricingDto,
  UpdateSubServicePricingDto,
  VerifyArtisanDocumentDto,
} from './dto/admin.dto';

import { Role } from '../../../generated/prisma/client';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(
  Role.ADMIN,
  Role.SUPER_ADMIN,
  Role.SUPPORT,
  Role.DISPATCHER,
  Role.ACCOUNTANT,
)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  // ==========================================================
  // 1. MAIN DASHBOARD
  // ==========================================================

  @Get('dashboard/kpis')
  getDashboardKpis(@Query() query: DashboardQueryDto) {
    return this.adminService.getDashboardKpis(query);
  }

  // ==========================================================
  // 2. INTERVENTION MANAGEMENT
  // ==========================================================

  // The dispatcher's list (P1-13): names, phones and addresses of every job, for the roles that work on
  // jobs. An accountant has no page that needs it.
  @Get('interventions')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.SUPPORT, Role.DISPATCHER)
  findAllInterventions(@Query() query: AdminInterventionQueryDto) {
    return this.adminService.findAllInterventions(query);
  }

  @Get('interventions/:id')
  getInterventionDetail(@Param('id', ParseIntPipe) id: number) {
    return this.adminService.getInterventionDetail(id);
  }

  @Post('interventions/:id/assign-artisan')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.DISPATCHER)
  assignArtisan(
    @CurrentUser('id') adminId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AssignArtisanDto,
  ) {
    return this.adminService.assignArtisan(adminId, id, dto);
  }

  @Patch('interventions/:id/status')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.DISPATCHER)
  changeInterventionStatus(
    @CurrentUser('id') adminId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ChangeInterventionStatusDto,
  ) {
    return this.adminService.changeInterventionStatus(adminId, id, dto);
  }

  @Patch('interventions/:id/cancel')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.DISPATCHER)
  cancelIntervention(
    @CurrentUser('id') adminId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CancelInterventionDto,
  ) {
    return this.adminService.cancelIntervention(adminId, id, dto);
  }

  @Post('interventions/:id/quotes')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.DISPATCHER)
  sendQuote(
    @CurrentUser('id') adminId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AdminSendQuoteDto,
  ) {
    return this.adminService.sendQuote(adminId, id, dto);
  }

  @Post('interventions/:id/internal-notes')
  addInterventionInternalNote(
    @CurrentUser('id') adminId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AdminInternalNoteDto,
  ) {
    return this.adminService.addInterventionInternalNote(adminId, id, dto);
  }

  // ==========================================================
  // 3. ARTISAN MANAGEMENT
  // ==========================================================

  // The applications queue (P1-12): applicants' identities and papers are for the people who check
  // them, not for every back-office role. A dispatcher assigns from GET /users/artisans.
  @Get('artisans')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.SUPPORT)
  findAllArtisans(@Query() query: AdminArtisanQueryDto) {
    return this.adminService.findAllArtisans(query);
  }

  @Get('artisans/:profileId')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.SUPPORT)
  getArtisanDetail(@Param('profileId', ParseIntPipe) profileId: number) {
    return this.adminService.getArtisanDetail(profileId);
  }

  @Post('artisans')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  createArtisanManually(
    @CurrentUser('id') adminId: number,
    @Body() dto: CreateArtisanManualDto,
  ) {
    return this.adminService.createArtisanManually(adminId, dto);
  }

  @Patch('artisans/:profileId')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  editArtisanProfile(
    @Param('profileId', ParseIntPipe) profileId: number,
    @Body() dto: EditArtisanProfileDto,
  ) {
    return this.adminService.editArtisanProfile(profileId, dto);
  }

  @Patch('artisans/:profileId/approve')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  approveArtisan(
    @CurrentUser('id') adminId: number,
    @Param('profileId', ParseIntPipe) profileId: number,
    @Body() dto: AdminApproveArtisanDto,
  ) {
    return this.adminService.approveArtisan(adminId, profileId, dto);
  }

  @Patch('artisans/:profileId/reject')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  rejectArtisan(
    @CurrentUser('id') adminId: number,
    @Param('profileId', ParseIntPipe) profileId: number,
    @Body() dto: AdminRejectArtisanDto,
  ) {
    return this.adminService.rejectArtisan(adminId, profileId, dto);
  }

  @Patch('artisans/:profileId/suspend')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  suspendArtisan(
    @CurrentUser('id') adminId: number,
    @Param('profileId', ParseIntPipe) profileId: number,
    @Body() dto: AdminReviewArtisanDto,
  ) {
    return this.adminService.suspendArtisan(adminId, profileId, dto);
  }

  @Patch('artisans/:profileId/reactivate')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  reactivateArtisan(
    @CurrentUser('id') adminId: number,
    @Param('profileId', ParseIntPipe) profileId: number,
    @Body() dto: AdminReviewArtisanDto,
  ) {
    return this.adminService.reactivateArtisan(adminId, profileId, dto);
  }

  @Patch('artisans/documents/:documentId/verify')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.SUPPORT)
  verifyArtisanDocument(
    @CurrentUser('id') adminId: number,
    @Param('documentId', ParseIntPipe) documentId: number,
    @Body() dto: VerifyArtisanDocumentDto,
  ) {
    return this.adminService.verifyArtisanDocument(adminId, documentId, dto);
  }

  @Get('artisans/:profileId/missions')
  getArtisanMissions(@Param('profileId', ParseIntPipe) profileId: number) {
    return this.adminService.getArtisanMissions(profileId);
  }

  @Get('artisans/:profileId/ratings')
  getArtisanRatings(@Param('profileId', ParseIntPipe) profileId: number) {
    return this.adminService.getArtisanRatings(profileId);
  }

  @Get('artisans/:profileId/location')
  getArtisanLocation(@Param('profileId', ParseIntPipe) profileId: number) {
    return this.adminService.getArtisanLocation(profileId);
  }

  @Get('artisans/:profileId/revenue')
  getArtisanRevenue(@Param('profileId', ParseIntPipe) profileId: number) {
    return this.adminService.getArtisanRevenue(profileId);
  }

  @Post('artisans/:profileId/internal-notes')
  addArtisanInternalNote(
    @CurrentUser('id') adminId: number,
    @Param('profileId', ParseIntPipe) profileId: number,
    @Body() dto: AdminInternalNoteDto,
  ) {
    return this.adminService.addArtisanInternalNote(adminId, profileId, dto);
  }

  // ==========================================================
  // 4. CLIENT MANAGEMENT
  // ==========================================================

  @Get('clients')
  findAllClients(@Query() query: AdminClientQueryDto) {
    return this.adminService.findAllClients(query);
  }

  @Get('clients/:clientId')
  getClientDetail(@Param('clientId', ParseIntPipe) clientId: number) {
    return this.adminService.getClientDetail(clientId);
  }

  @Patch('clients/:clientId')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.SUPPORT)
  editClient(
    @Param('clientId', ParseIntPipe) clientId: number,
    @Body() dto: EditClientDto,
  ) {
    return this.adminService.editClient(clientId, dto);
  }

  @Patch('clients/:clientId/deactivate')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  deactivateClient(@Param('clientId', ParseIntPipe) clientId: number) {
    return this.adminService.deactivateClient(clientId);
  }

  @Post('clients/:clientId/internal-notes')
  addClientInternalNote(
    @CurrentUser('id') adminId: number,
    @Param('clientId', ParseIntPipe) clientId: number,
    @Body() dto: AdminInternalNoteDto,
  ) {
    return this.adminService.addClientInternalNote(adminId, clientId, dto);
  }

  // ==========================================================
  // 5. COMPLAINT CENTER
  // ==========================================================

  @Get('complaints')
  findAllComplaints(@Query() query: AdminComplaintQueryDto) {
    return this.adminService.findAllComplaints(query);
  }

  @Get('complaints/:complaintId')
  getComplaintDetail(
    @Param('complaintId', ParseIntPipe) complaintId: number,
  ) {
    return this.adminService.getComplaintDetail(complaintId);
  }

  @Patch('complaints/:complaintId/assign')
  assignComplaint(
    @CurrentUser('id') adminId: number,
    @Param('complaintId', ParseIntPipe) complaintId: number,
    @Body() dto: AssignComplaintDto,
  ) {
    return this.adminService.assignComplaint(adminId, complaintId, dto);
  }

  @Patch('complaints/:complaintId/status')
  updateComplaintStatus(
    @CurrentUser('id') adminId: number,
    @Param('complaintId', ParseIntPipe) complaintId: number,
    @Body() dto: UpdateComplaintStatusDto,
  ) {
    return this.adminService.updateComplaintStatus(
      adminId,
      complaintId,
      dto,
    );
  }

  @Post('complaints/:complaintId/internal-notes')
  addComplaintInternalNote(
    @CurrentUser('id') adminId: number,
    @Param('complaintId', ParseIntPipe) complaintId: number,
    @Body() dto: AdminInternalNoteDto,
  ) {
    return this.adminService.addComplaintInternalNote(
      adminId,
      complaintId,
      dto,
    );
  }

  @Post('complaints/:complaintId/contact-client')
  complaintContactClient(
    @CurrentUser('id') adminId: number,
    @Param('complaintId', ParseIntPipe) complaintId: number,
    @Body() dto: AdminContactDto,
  ) {
    return this.adminService.complaintContactClient(
      adminId,
      complaintId,
      dto,
    );
  }

  @Post('complaints/:complaintId/contact-artisan')
  complaintContactArtisan(
    @CurrentUser('id') adminId: number,
    @Param('complaintId', ParseIntPipe) complaintId: number,
    @Body() dto: AdminContactDto,
  ) {
    return this.adminService.complaintContactArtisan(
      adminId,
      complaintId,
      dto,
    );
  }

  @Patch('complaints/:complaintId/refund')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.ACCOUNTANT)
  decideRefund(
    @CurrentUser('id') adminId: number,
    @Param('complaintId', ParseIntPipe) complaintId: number,
    @Body() dto: DecideRefundDto,
  ) {
    return this.adminService.decideRefund(adminId, complaintId, dto);
  }

  @Patch('complaints/:complaintId/close')
  closeComplaint(
    @CurrentUser('id') adminId: number,
    @Param('complaintId', ParseIntPipe) complaintId: number,
    @Body() dto: AdminInternalNoteDto,
  ) {
    return this.adminService.closeComplaint(adminId, complaintId, dto);
  }

  // ==========================================================
  // 6. SETTINGS
  // ==========================================================

  @Get('settings/company')
  getCompanySettings() {
    return this.adminService.getCompanySettings();
  }

  @Patch('settings/company')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  updateCompanySettings(@Body() dto: UpdateCompanySettingsDto) {
    return this.adminService.updateCompanySettings(dto);
  }

  @Get('settings/service-zones')
  findServiceZones() {
    return this.adminService.findServiceZones();
  }

  @Post('settings/service-zones')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  createServiceZone(@Body() dto: CreateAdminServiceZoneDto) {
    return this.adminService.createServiceZone(dto);
  }

  @Patch('settings/service-zones/:zoneId')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  updateServiceZone(
    @Param('zoneId', ParseIntPipe) zoneId: number,
    @Body() dto: UpdateAdminServiceZoneDto,
  ) {
    return this.adminService.updateServiceZone(zoneId, dto);
  }

  @Delete('settings/service-zones/:zoneId')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  deleteServiceZone(@Param('zoneId', ParseIntPipe) zoneId: number) {
    return this.adminService.deleteServiceZone(zoneId);
  }

  @Patch('settings/service-categories/:categoryId')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  updateServiceCategory(
    @Param('categoryId', ParseIntPipe) categoryId: number,
    @Body() dto: UpdateServiceCategoryPricingDto,
  ) {
    return this.adminService.updateServiceCategory(categoryId, dto);
  }

  @Patch('settings/sub-services/:subServiceId')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  updateSubServicePricing(
    @Param('subServiceId', ParseIntPipe) subServiceId: number,
    @Body() dto: UpdateSubServicePricingDto,
  ) {
    return this.adminService.updateSubServicePricing(subServiceId, dto);
  }

  @Get('settings/notification-templates')
  findNotificationTemplates() {
    return this.adminService.findNotificationTemplates();
  }

  @Post('settings/notification-templates')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  createNotificationTemplate(@Body() dto: CreateNotificationTemplateDto) {
    return this.adminService.createNotificationTemplate(dto);
  }

  @Patch('settings/notification-templates/:templateId')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  updateNotificationTemplate(
    @Param('templateId', ParseIntPipe) templateId: number,
    @Body() dto: UpdateNotificationTemplateDto,
  ) {
    return this.adminService.updateNotificationTemplate(templateId, dto);
  }

  @Delete('settings/notification-templates/:templateId')
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  deleteNotificationTemplate(
    @Param('templateId', ParseIntPipe) templateId: number,
  ) {
    return this.adminService.deleteNotificationTemplate(templateId);
  }
}
