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
  InterventionNoteDto,
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

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Permission } from '../../common/auth/permissions';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@Controller('admin')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  // ==========================================================
  // 1. MAIN DASHBOARD
  // ==========================================================

  @RequirePermission(Permission.DASHBOARD_KPIS)
  @Get('dashboard/kpis')
  getDashboardKpis(@Query() query: DashboardQueryDto) {
    return this.adminService.getDashboardKpis(query);
  }

  // ==========================================================
  // 2. INTERVENTION MANAGEMENT
  // ==========================================================

  // The dispatcher's list (P1-13): names, phones and addresses of every job, for the roles that work on
  // jobs. An accountant has no page that needs it.
  @RequirePermission(Permission.TICKETS_READ)
  @Get('interventions')
  findAllInterventions(@Query() query: AdminInterventionQueryDto) {
    return this.adminService.findAllInterventions(query);
  }

  // The case file of a job (P1-14): the whole history for the people who work on jobs, not for the accountant.
  @RequirePermission(Permission.TICKETS_READ)
  @Get('interventions/:id')
  getInterventionDetail(@Param('id', ParseIntPipe) id: number) {
    return this.adminService.getInterventionDetail(id);
  }

  @RequirePermission(Permission.TICKETS_DISPATCH)
  @Post('interventions/:id/assign-artisan')
  assignArtisan(
    @CurrentUser('id') adminId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AssignArtisanDto,
  ) {
    return this.adminService.assignArtisan(adminId, id, dto);
  }

  @RequirePermission(Permission.TICKETS_DISPATCH)
  @Patch('interventions/:id/status')
  changeInterventionStatus(
    @CurrentUser('id') adminId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ChangeInterventionStatusDto,
  ) {
    return this.adminService.changeInterventionStatus(adminId, id, dto);
  }

  @RequirePermission(Permission.TICKETS_DISPATCH)
  @Patch('interventions/:id/cancel')
  cancelIntervention(
    @CurrentUser('id') adminId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CancelInterventionDto,
  ) {
    return this.adminService.cancelIntervention(adminId, id, dto);
  }

  @RequirePermission(Permission.TICKETS_DISPATCH)
  @Post('interventions/:id/quotes')
  sendQuote(
    @CurrentUser('id') adminId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AdminSendQuoteDto,
  ) {
    return this.adminService.sendQuote(adminId, id, dto);
  }

  // A note on a job: written by the roles that can read the case file it appears in.
  @RequirePermission(Permission.TICKETS_NOTE)
  @Post('interventions/:id/internal-notes')
  addInterventionInternalNote(
    @CurrentUser('id') adminId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: InterventionNoteDto,
  ) {
    return this.adminService.addInterventionInternalNote(adminId, id, dto);
  }

  // ==========================================================
  // 3. ARTISAN MANAGEMENT
  // ==========================================================

  // The applications queue (P1-12): applicants' identities and papers are for the people who check
  // them, not for every back-office role. A dispatcher assigns from GET /users/artisans.
  @RequirePermission(Permission.ARTISANS_REVIEW)
  @Get('artisans')
  findAllArtisans(@Query() query: AdminArtisanQueryDto) {
    return this.adminService.findAllArtisans(query);
  }

  @RequirePermission(Permission.ARTISANS_REVIEW)
  @Get('artisans/:profileId')
  getArtisanDetail(@Param('profileId', ParseIntPipe) profileId: number) {
    return this.adminService.getArtisanDetail(profileId);
  }

  @RequirePermission(Permission.ARTISANS_MANAGE)
  @Post('artisans')
  createArtisanManually(
    @CurrentUser('id') adminId: number,
    @Body() dto: CreateArtisanManualDto,
  ) {
    return this.adminService.createArtisanManually(adminId, dto);
  }

  @RequirePermission(Permission.ARTISANS_MANAGE)
  @Patch('artisans/:profileId')
  editArtisanProfile(
    @Param('profileId', ParseIntPipe) profileId: number,
    @Body() dto: EditArtisanProfileDto,
  ) {
    return this.adminService.editArtisanProfile(profileId, dto);
  }

  @RequirePermission(Permission.ARTISANS_MANAGE)
  @Patch('artisans/:profileId/approve')
  approveArtisan(
    @CurrentUser('id') adminId: number,
    @Param('profileId', ParseIntPipe) profileId: number,
    @Body() dto: AdminApproveArtisanDto,
  ) {
    return this.adminService.approveArtisan(adminId, profileId, dto);
  }

  @RequirePermission(Permission.ARTISANS_MANAGE)
  @Patch('artisans/:profileId/reject')
  rejectArtisan(
    @CurrentUser('id') adminId: number,
    @Param('profileId', ParseIntPipe) profileId: number,
    @Body() dto: AdminRejectArtisanDto,
  ) {
    return this.adminService.rejectArtisan(adminId, profileId, dto);
  }

  @RequirePermission(Permission.ARTISANS_MANAGE)
  @Patch('artisans/:profileId/suspend')
  suspendArtisan(
    @CurrentUser('id') adminId: number,
    @Param('profileId', ParseIntPipe) profileId: number,
    @Body() dto: AdminReviewArtisanDto,
  ) {
    return this.adminService.suspendArtisan(adminId, profileId, dto);
  }

  @RequirePermission(Permission.ARTISANS_MANAGE)
  @Patch('artisans/:profileId/reactivate')
  reactivateArtisan(
    @CurrentUser('id') adminId: number,
    @Param('profileId', ParseIntPipe) profileId: number,
    @Body() dto: AdminReviewArtisanDto,
  ) {
    return this.adminService.reactivateArtisan(adminId, profileId, dto);
  }

  @RequirePermission(Permission.ARTISANS_REVIEW)
  @Patch('artisans/documents/:documentId/verify')
  verifyArtisanDocument(
    @CurrentUser('id') adminId: number,
    @Param('documentId', ParseIntPipe) documentId: number,
    @Body() dto: VerifyArtisanDocumentDto,
  ) {
    return this.adminService.verifyArtisanDocument(adminId, documentId, dto);
  }

  @RequirePermission(Permission.ARTISANS_ACTIVITY)
  @Get('artisans/:profileId/missions')
  getArtisanMissions(@Param('profileId', ParseIntPipe) profileId: number) {
    return this.adminService.getArtisanMissions(profileId);
  }

  @RequirePermission(Permission.ARTISANS_ACTIVITY)
  @Get('artisans/:profileId/ratings')
  getArtisanRatings(@Param('profileId', ParseIntPipe) profileId: number) {
    return this.adminService.getArtisanRatings(profileId);
  }

  @RequirePermission(Permission.ARTISANS_ACTIVITY)
  @Get('artisans/:profileId/location')
  getArtisanLocation(@Param('profileId', ParseIntPipe) profileId: number) {
    return this.adminService.getArtisanLocation(profileId);
  }

  @RequirePermission(Permission.ARTISANS_ACTIVITY)
  @Get('artisans/:profileId/revenue')
  getArtisanRevenue(@Param('profileId', ParseIntPipe) profileId: number) {
    return this.adminService.getArtisanRevenue(profileId);
  }

  @RequirePermission(Permission.NOTES_WRITE)
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

  @RequirePermission(Permission.CLIENTS_READ)
  @Get('clients')
  findAllClients(@Query() query: AdminClientQueryDto) {
    return this.adminService.findAllClients(query);
  }

  @RequirePermission(Permission.CLIENTS_READ)
  @Get('clients/:clientId')
  getClientDetail(@Param('clientId', ParseIntPipe) clientId: number) {
    return this.adminService.getClientDetail(clientId);
  }

  @RequirePermission(Permission.CLIENTS_EDIT)
  @Patch('clients/:clientId')
  editClient(
    @Param('clientId', ParseIntPipe) clientId: number,
    @Body() dto: EditClientDto,
  ) {
    return this.adminService.editClient(clientId, dto);
  }

  @RequirePermission(Permission.CLIENTS_DEACTIVATE)
  @Patch('clients/:clientId/deactivate')
  deactivateClient(@Param('clientId', ParseIntPipe) clientId: number) {
    return this.adminService.deactivateClient(clientId);
  }

  @RequirePermission(Permission.NOTES_WRITE)
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

  // The reads of the complaints are for the roles that have the page (P2-09): not for the dispatcher, who has no use for the contacts,
  // the notes and the money of a complaint.
  @RequirePermission(Permission.COMPLAINTS_READ)
  @Get('complaints')
  findAllComplaints(
    @CurrentUser('id') adminId: number,
    @Query() query: AdminComplaintQueryDto,
  ) {
    return this.adminService.findAllComplaints(query, adminId);
  }

  @RequirePermission(Permission.COMPLAINTS_READ)
  @Get('complaints/:complaintId')
  getComplaintDetail(
    @Param('complaintId', ParseIntPipe) complaintId: number,
  ) {
    return this.adminService.getComplaintCase(complaintId);
  }

  @RequirePermission(Permission.COMPLAINTS_HANDLE)
  @Patch('complaints/:complaintId/assign')
  assignComplaint(
    @CurrentUser('id') adminId: number,
    @Param('complaintId', ParseIntPipe) complaintId: number,
    @Body() dto: AssignComplaintDto,
  ) {
    return this.adminService.assignComplaint(adminId, complaintId, dto);
  }

  @RequirePermission(Permission.COMPLAINTS_HANDLE)
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

  @RequirePermission(Permission.COMPLAINTS_HANDLE)
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

  @RequirePermission(Permission.COMPLAINTS_HANDLE)
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

  @RequirePermission(Permission.COMPLAINTS_HANDLE)
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

  @RequirePermission(Permission.COMPLAINTS_REFUND)
  @Patch('complaints/:complaintId/refund')
  decideRefund(
    @CurrentUser('id') adminId: number,
    @Param('complaintId', ParseIntPipe) complaintId: number,
    @Body() dto: DecideRefundDto,
  ) {
    return this.adminService.decideRefund(adminId, complaintId, dto);
  }

  @RequirePermission(Permission.COMPLAINTS_HANDLE)
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

  // The company is read by the roles that have its page (P2-09): the RIB and the tax numbers are not for support or dispatch.
  @RequirePermission(Permission.COMPANY_READ)
  @Get('settings/company')
  getCompanySettings() {
    return this.adminService.getCompanySettings();
  }

  @RequirePermission(Permission.SETTINGS_MANAGE)
  @Patch('settings/company')
  updateCompanySettings(@Body() dto: UpdateCompanySettingsDto) {
    return this.adminService.updateCompanySettings(dto);
  }

  @RequirePermission(Permission.SETTINGS_READ)
  @Get('settings/service-zones')
  findServiceZones() {
    return this.adminService.findServiceZones();
  }

  @RequirePermission(Permission.SETTINGS_MANAGE)
  @Post('settings/service-zones')
  createServiceZone(@Body() dto: CreateAdminServiceZoneDto) {
    return this.adminService.createServiceZone(dto);
  }

  @RequirePermission(Permission.SETTINGS_MANAGE)
  @Patch('settings/service-zones/:zoneId')
  updateServiceZone(
    @Param('zoneId', ParseIntPipe) zoneId: number,
    @Body() dto: UpdateAdminServiceZoneDto,
  ) {
    return this.adminService.updateServiceZone(zoneId, dto);
  }

  @RequirePermission(Permission.SETTINGS_MANAGE)
  @Delete('settings/service-zones/:zoneId')
  deleteServiceZone(@Param('zoneId', ParseIntPipe) zoneId: number) {
    return this.adminService.deleteServiceZone(zoneId);
  }

  @RequirePermission(Permission.SETTINGS_MANAGE)
  @Patch('settings/service-categories/:categoryId')
  updateServiceCategory(
    @Param('categoryId', ParseIntPipe) categoryId: number,
    @Body() dto: UpdateServiceCategoryPricingDto,
  ) {
    return this.adminService.updateServiceCategory(categoryId, dto);
  }

  @RequirePermission(Permission.SETTINGS_MANAGE)
  @Patch('settings/sub-services/:subServiceId')
  updateSubServicePricing(
    @Param('subServiceId', ParseIntPipe) subServiceId: number,
    @Body() dto: UpdateSubServicePricingDto,
  ) {
    return this.adminService.updateSubServicePricing(subServiceId, dto);
  }

  @RequirePermission(Permission.SETTINGS_READ)
  @Get('settings/notification-templates')
  findNotificationTemplates() {
    return this.adminService.findNotificationTemplates();
  }

  @RequirePermission(Permission.SETTINGS_MANAGE)
  @Post('settings/notification-templates')
  createNotificationTemplate(@Body() dto: CreateNotificationTemplateDto) {
    return this.adminService.createNotificationTemplate(dto);
  }

  @RequirePermission(Permission.SETTINGS_MANAGE)
  @Patch('settings/notification-templates/:templateId')
  updateNotificationTemplate(
    @Param('templateId', ParseIntPipe) templateId: number,
    @Body() dto: UpdateNotificationTemplateDto,
  ) {
    return this.adminService.updateNotificationTemplate(templateId, dto);
  }

  @RequirePermission(Permission.SETTINGS_MANAGE)
  @Delete('settings/notification-templates/:templateId')
  deleteNotificationTemplate(
    @Param('templateId', ParseIntPipe) templateId: number,
  ) {
    return this.adminService.deleteNotificationTemplate(templateId);
  }
}
