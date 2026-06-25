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

import { ArtisansService } from './artisans.service';

import { ApplyArtisanDto } from './dto/apply-artisan.dto';
import { UpdateArtisanProfileDto } from './dto/update-artisan-profile.dto';
import { UploadArtisanDocumentDto } from './dto/upload-artisan-document.dto';
import { CreateServiceZoneDto } from './dto/create-service-zone.dto';
import { UpdateAvailabilityDto } from './dto/update-availability.dto';
import { UpdateBankDetailsDto } from './dto/update-bank-details.dto';
import { UpdateArtisanLocationDto } from './dto/update-artisan-location.dto';
import { RejectMissionDto } from './dto/reject-mission.dto';
import { UploadProofPhotoDto } from './dto/upload-proof-photo.dto';
import { AddDiagnosticDto } from './dto/add-diagnostic.dto';
import { AddMaterialUsedDto } from './dto/add-material-used.dto';
import { RequestExtraQuoteDto } from './dto/request-extra-quote.dto';
import { CollectSignatureDto } from './dto/collect-signature.dto';
import { ReportProblemDto } from './dto/report-problem.dto';
import { ContactMessageDto } from './dto/contact-message.dto';
import { AdminReviewArtisanDto } from './dto/admin-review-artisan.dto';

import {
  ArtisanVerificationStatus,
  Role,
} from '../../../generated/prisma/client';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@Controller('artisans')
export class ArtisansController {
  constructor(private readonly artisansService: ArtisansService) {}

  // ==========================================================
  // 1. PUBLIC ONBOARDING
  // ==========================================================

  @Post('apply')
  apply(@Body() dto: ApplyArtisanDto) {
    return this.artisansService.apply(dto);
  }

  // ==========================================================
  // 2. ARTISAN PROFILE
  // ==========================================================

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ARTISAN, Role.ADMIN, Role.SUPER_ADMIN)
  @Get('me/profile')
  getMyProfile(@CurrentUser('id') userId: number) {
    return this.artisansService.getMyProfile(userId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ARTISAN, Role.ADMIN, Role.SUPER_ADMIN)
  @Patch('me/profile')
  updateMyProfile(
    @CurrentUser('id') userId: number,
    @Body() dto: UpdateArtisanProfileDto,
  ) {
    return this.artisansService.updateMyProfile(userId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ARTISAN, Role.ADMIN, Role.SUPER_ADMIN)
  @Post('me/documents')
  uploadDocument(
    @CurrentUser('id') userId: number,
    @Body() dto: UploadArtisanDocumentDto,
  ) {
    return this.artisansService.uploadDocument(userId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ARTISAN, Role.ADMIN, Role.SUPER_ADMIN)
  @Post('me/service-zones')
  addServiceZone(
    @CurrentUser('id') userId: number,
    @Body() dto: CreateServiceZoneDto,
  ) {
    return this.artisansService.addServiceZone(userId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ARTISAN, Role.ADMIN, Role.SUPER_ADMIN)
  @Delete('me/service-zones/:zoneId')
  removeServiceZone(
    @CurrentUser('id') userId: number,
    @Param('zoneId', ParseIntPipe) zoneId: number,
  ) {
    return this.artisansService.removeServiceZone(userId, zoneId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ARTISAN, Role.ADMIN, Role.SUPER_ADMIN)
  @Patch('me/availability')
  updateAvailability(
    @CurrentUser('id') userId: number,
    @Body() dto: UpdateAvailabilityDto,
  ) {
    return this.artisansService.updateAvailability(userId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ARTISAN, Role.ADMIN, Role.SUPER_ADMIN)
  @Patch('me/bank-details')
  updateBankDetails(
    @CurrentUser('id') userId: number,
    @Body() dto: UpdateBankDetailsDto,
  ) {
    return this.artisansService.updateBankDetails(userId, dto);
  }

  // ==========================================================
  // 3. LOCATION / ONLINE OFFLINE
  // ==========================================================

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ARTISAN)
  @Patch('me/location')
  updateLocation(
    @CurrentUser('id') userId: number,
    @Body() dto: UpdateArtisanLocationDto,
  ) {
    return this.artisansService.updateLocation(userId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ARTISAN)
  @Patch('me/online')
  setOnline(@CurrentUser('id') userId: number) {
    return this.artisansService.setOnline(userId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ARTISAN)
  @Patch('me/offline')
  setOffline(@CurrentUser('id') userId: number) {
    return this.artisansService.setOffline(userId);
  }

  // ==========================================================
  // 4. MISSION BOARD
  // ==========================================================

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ARTISAN)
  @Get('me/missions')
  getMissionBoard(@CurrentUser('id') userId: number) {
    return this.artisansService.getMissionBoard(userId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ARTISAN)
  @Get('me/missions/:interventionId')
  getMissionDetails(
    @CurrentUser('id') userId: number,
    @Param('interventionId', ParseIntPipe) interventionId: number,
  ) {
    return this.artisansService.getMissionDetails(userId, interventionId);
  }

  // ==========================================================
  // 5. MISSION ACTIONS
  // ==========================================================

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ARTISAN)
  @Post('me/missions/:interventionId/accept')
  acceptMission(
    @CurrentUser('id') userId: number,
    @Param('interventionId', ParseIntPipe) interventionId: number,
  ) {
    return this.artisansService.acceptMission(userId, interventionId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ARTISAN)
  @Post('me/missions/:interventionId/reject')
  rejectMission(
    @CurrentUser('id') userId: number,
    @Param('interventionId', ParseIntPipe) interventionId: number,
    @Body() dto: RejectMissionDto,
  ) {
    return this.artisansService.rejectMission(userId, interventionId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ARTISAN)
  @Patch('me/missions/:interventionId/on-the-way')
  markOnTheWay(
    @CurrentUser('id') userId: number,
    @Param('interventionId', ParseIntPipe) interventionId: number,
  ) {
    return this.artisansService.markOnTheWay(userId, interventionId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ARTISAN)
  @Patch('me/missions/:interventionId/arrived')
  markArrived(
    @CurrentUser('id') userId: number,
    @Param('interventionId', ParseIntPipe) interventionId: number,
  ) {
    return this.artisansService.markArrived(userId, interventionId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ARTISAN)
  @Patch('me/missions/:interventionId/start')
  startIntervention(
    @CurrentUser('id') userId: number,
    @Param('interventionId', ParseIntPipe) interventionId: number,
  ) {
    return this.artisansService.startIntervention(userId, interventionId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ARTISAN)
  @Post('me/missions/:interventionId/before-photo')
  uploadBeforePhoto(
    @CurrentUser('id') userId: number,
    @Param('interventionId', ParseIntPipe) interventionId: number,
    @Body() dto: UploadProofPhotoDto,
  ) {
    return this.artisansService.uploadBeforePhoto(
      userId,
      interventionId,
      dto,
    );
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ARTISAN)
  @Patch('me/missions/:interventionId/diagnostic')
  addDiagnostic(
    @CurrentUser('id') userId: number,
    @Param('interventionId', ParseIntPipe) interventionId: number,
    @Body() dto: AddDiagnosticDto,
  ) {
    return this.artisansService.addDiagnostic(userId, interventionId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ARTISAN)
  @Patch('me/missions/:interventionId/materials')
  addMaterialUsed(
    @CurrentUser('id') userId: number,
    @Param('interventionId', ParseIntPipe) interventionId: number,
    @Body() dto: AddMaterialUsedDto,
  ) {
    return this.artisansService.addMaterialUsed(userId, interventionId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ARTISAN)
  @Post('me/missions/:interventionId/extra-quote')
  requestExtraQuote(
    @CurrentUser('id') userId: number,
    @Param('interventionId', ParseIntPipe) interventionId: number,
    @Body() dto: RequestExtraQuoteDto,
  ) {
    return this.artisansService.requestExtraQuote(
      userId,
      interventionId,
      dto,
    );
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ARTISAN)
  @Post('me/missions/:interventionId/after-photo')
  uploadAfterPhoto(
    @CurrentUser('id') userId: number,
    @Param('interventionId', ParseIntPipe) interventionId: number,
    @Body() dto: UploadProofPhotoDto,
  ) {
    return this.artisansService.uploadAfterPhoto(
      userId,
      interventionId,
      dto,
    );
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ARTISAN)
  @Post('me/missions/:interventionId/signature')
  collectClientSignature(
    @CurrentUser('id') userId: number,
    @Param('interventionId', ParseIntPipe) interventionId: number,
    @Body() dto: CollectSignatureDto,
  ) {
    return this.artisansService.collectClientSignature(
      userId,
      interventionId,
      dto,
    );
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ARTISAN)
  @Patch('me/missions/:interventionId/complete')
  completeIntervention(
    @CurrentUser('id') userId: number,
    @Param('interventionId', ParseIntPipe) interventionId: number,
  ) {
    return this.artisansService.completeIntervention(userId, interventionId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ARTISAN)
  @Post('me/missions/:interventionId/problem')
  reportProblem(
    @CurrentUser('id') userId: number,
    @Param('interventionId', ParseIntPipe) interventionId: number,
    @Body() dto: ReportProblemDto,
  ) {
    return this.artisansService.reportProblem(userId, interventionId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ARTISAN)
  @Post('me/missions/:interventionId/contact-client')
  contactClient(
    @CurrentUser('id') userId: number,
    @Param('interventionId', ParseIntPipe) interventionId: number,
    @Body() dto: ContactMessageDto,
  ) {
    return this.artisansService.contactClient(userId, interventionId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ARTISAN)
  @Post('me/missions/:interventionId/contact-admin')
  contactAdmin(
    @CurrentUser('id') userId: number,
    @Param('interventionId', ParseIntPipe) interventionId: number,
    @Body() dto: ContactMessageDto,
  ) {
    return this.artisansService.contactAdmin(userId, interventionId, dto);
  }

  // ==========================================================
  // 6. ADMIN ARTISAN MANAGEMENT
  // ==========================================================

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.SUPPORT)
  @Get('admin')
  adminFindAll(
    @Query('status') status?: ArtisanVerificationStatus,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.artisansService.adminFindAll({
      status,
      search,
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 20,
    });
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.SUPPORT)
  @Get('admin/:profileId')
  adminFindOne(@Param('profileId', ParseIntPipe) profileId: number) {
    return this.artisansService.adminFindOne(profileId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Patch('admin/:profileId/approve')
  approveArtisan(
    @CurrentUser('id') adminId: number,
    @Param('profileId', ParseIntPipe) profileId: number,
    @Body() dto: AdminReviewArtisanDto,
  ) {
    return this.artisansService.approveArtisan(adminId, profileId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Patch('admin/:profileId/reject')
  rejectArtisan(
    @CurrentUser('id') adminId: number,
    @Param('profileId', ParseIntPipe) profileId: number,
    @Body() dto: AdminReviewArtisanDto,
  ) {
    return this.artisansService.rejectArtisan(adminId, profileId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Patch('admin/:profileId/suspend')
  suspendArtisan(
    @CurrentUser('id') adminId: number,
    @Param('profileId', ParseIntPipe) profileId: number,
    @Body() dto: AdminReviewArtisanDto,
  ) {
    return this.artisansService.suspendArtisan(adminId, profileId, dto);
  }
}