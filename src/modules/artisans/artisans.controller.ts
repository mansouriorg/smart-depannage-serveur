import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Req,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';

import { ArtisansService } from './artisans.service';
import { APPLICANT_DOCUMENT_MAX_MB } from '../files/files.service';
import { parseApplication } from './apply-form';

import { UpdateArtisanProfileDto } from './dto/update-artisan-profile.dto';
import { UploadArtisanDocumentDto } from './dto/upload-artisan-document.dto';
import { CreateServiceZoneDto } from './dto/create-service-zone.dto';
import { UpdateAvailabilityDto } from './dto/update-availability.dto';
import { UpdateBankDetailsDto } from './dto/update-bank-details.dto';
import { UpdateArtisanLocationDto } from './dto/update-artisan-location.dto';
import { RejectMissionDto } from './dto/reject-mission.dto';
import { AddDiagnosticDto } from './dto/add-diagnostic.dto';
import { AddMaterialUsedDto } from './dto/add-material-used.dto';
import { RequestExtraQuoteDto } from './dto/request-extra-quote.dto';
import { CollectSignatureDto } from './dto/collect-signature.dto';
import { ReportProblemDto } from './dto/report-problem.dto';
import { ContactMessageDto } from './dto/contact-message.dto';

import { RateLimit, RateLimitGuard } from '../../common/rate-limit/rate-limit.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Permission } from '../../common/auth/permissions';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { declaredLocale } from '../../common/i18n/messages';

@Controller('artisans')
export class ArtisansController {
  constructor(private readonly artisansService: ArtisansService) {}

  // ==========================================================
  // 1. PUBLIC ONBOARDING
  // ==========================================================

  // Public, and it sends an e-mail and an SMS to what was typed: capped per visitor here
  // and per destination in the service. One multipart request (P1-11): the form as JSON in the
  // `data` field, and the documents as files (the identity document is required). The guard runs
  // before the upload is read, so a visitor over the cap costs nothing.
  @UseGuards(RateLimitGuard)
  @RateLimit({ name: 'artisan-apply', limit: 5, windowMs: 60 * 60_000 })
  @Post('apply')
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'identityDocument', maxCount: 1 },
        { name: 'companyDocument', maxCount: 1 },
        { name: 'insuranceCertificate', maxCount: 1 },
      ],
      {
        storage: memoryStorage(),
        limits: { fileSize: APPLICANT_DOCUMENT_MAX_MB * 1024 * 1024, files: 3, fields: 2, fieldSize: 64 * 1024 },
      },
    ),
  )
  apply(
    @Body('data') data: unknown,
    @UploadedFiles()
    files: {
      identityDocument?: Express.Multer.File[];
      companyDocument?: Express.Multer.File[];
      insuranceCertificate?: Express.Multer.File[];
    } = {},
    @Req() request?: any,
  ) {
    const dto = parseApplication(data);

    const documents = {
      identity: files?.identityDocument?.[0],
      company: files?.companyDocument?.[0],
      insurance: files?.insuranceCertificate?.[0],
    };

    // The language the form was shown in (X-App-Locale): the applicant's account starts in it, and so do the messages (P3-04).
    return this.artisansService.apply(dto, documents, declaredLocale(request));
  }

  // ==========================================================
  // 2. ARTISAN PROFILE
  // ==========================================================

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.ARTISAN_PROFILE)
  @Get('me/profile')
  getMyProfile(@CurrentUser('id') userId: number) {
    return this.artisansService.getMyProfile(userId);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.ARTISAN_PROFILE)
  @Patch('me/profile')
  updateMyProfile(
    @CurrentUser('id') userId: number,
    @Body() dto: UpdateArtisanProfileDto,
  ) {
    return this.artisansService.updateMyProfile(userId, dto);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.ARTISAN_PROFILE)
  @Post('me/documents')
  uploadDocument(
    @CurrentUser('id') userId: number,
    @Body() dto: UploadArtisanDocumentDto,
  ) {
    return this.artisansService.uploadDocument(userId, dto);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.ARTISAN_PROFILE)
  @Post('me/service-zones')
  addServiceZone(
    @CurrentUser('id') userId: number,
    @Body() dto: CreateServiceZoneDto,
  ) {
    return this.artisansService.addServiceZone(userId, dto);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.ARTISAN_PROFILE)
  @Delete('me/service-zones/:zoneId')
  removeServiceZone(
    @CurrentUser('id') userId: number,
    @Param('zoneId', ParseIntPipe) zoneId: number,
  ) {
    return this.artisansService.removeServiceZone(userId, zoneId);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.ARTISAN_PROFILE)
  @Patch('me/availability')
  updateAvailability(
    @CurrentUser('id') userId: number,
    @Body() dto: UpdateAvailabilityDto,
  ) {
    return this.artisansService.updateAvailability(userId, dto);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.ARTISAN_PROFILE)
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

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.ARTISAN_PRESENCE)
  @Patch('me/location')
  updateLocation(
    @CurrentUser('id') userId: number,
    @Body() dto: UpdateArtisanLocationDto,
  ) {
    return this.artisansService.updateLocation(userId, dto);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.ARTISAN_PRESENCE)
  @Patch('me/online')
  setOnline(@CurrentUser('id') userId: number) {
    return this.artisansService.setOnline(userId);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.ARTISAN_PRESENCE)
  @Patch('me/offline')
  setOffline(@CurrentUser('id') userId: number) {
    return this.artisansService.setOffline(userId);
  }

  // ==========================================================
  // 4. MISSION BOARD
  // ==========================================================

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.MISSIONS_WORK)
  @Get('me/missions')
  getMissionBoard(@CurrentUser('id') userId: number) {
    return this.artisansService.getMissionBoard(userId);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.MISSIONS_WORK)
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

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.MISSIONS_WORK)
  @Post('me/missions/:interventionId/accept')
  acceptMission(
    @CurrentUser('id') userId: number,
    @Param('interventionId', ParseIntPipe) interventionId: number,
  ) {
    return this.artisansService.acceptMission(userId, interventionId);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.MISSIONS_WORK)
  @Post('me/missions/:interventionId/reject')
  rejectMission(
    @CurrentUser('id') userId: number,
    @Param('interventionId', ParseIntPipe) interventionId: number,
    @Body() dto: RejectMissionDto,
  ) {
    return this.artisansService.rejectMission(userId, interventionId, dto);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.MISSIONS_WORK)
  @Patch('me/missions/:interventionId/on-the-way')
  markOnTheWay(
    @CurrentUser('id') userId: number,
    @Param('interventionId', ParseIntPipe) interventionId: number,
  ) {
    return this.artisansService.markOnTheWay(userId, interventionId);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.MISSIONS_WORK)
  @Patch('me/missions/:interventionId/arrived')
  markArrived(
    @CurrentUser('id') userId: number,
    @Param('interventionId', ParseIntPipe) interventionId: number,
  ) {
    return this.artisansService.markArrived(userId, interventionId);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.MISSIONS_WORK)
  @Patch('me/missions/:interventionId/start')
  startIntervention(
    @CurrentUser('id') userId: number,
    @Param('interventionId', ParseIntPipe) interventionId: number,
  ) {
    return this.artisansService.startIntervention(userId, interventionId);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.MISSIONS_WORK)
  @Patch('me/missions/:interventionId/diagnostic')
  addDiagnostic(
    @CurrentUser('id') userId: number,
    @Param('interventionId', ParseIntPipe) interventionId: number,
    @Body() dto: AddDiagnosticDto,
  ) {
    return this.artisansService.addDiagnostic(userId, interventionId, dto);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.MISSIONS_WORK)
  @Patch('me/missions/:interventionId/materials')
  addMaterialUsed(
    @CurrentUser('id') userId: number,
    @Param('interventionId', ParseIntPipe) interventionId: number,
    @Body() dto: AddMaterialUsedDto,
  ) {
    return this.artisansService.addMaterialUsed(userId, interventionId, dto);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.MISSIONS_WORK)
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

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.MISSIONS_WORK)
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

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.MISSIONS_WORK)
  @Patch('me/missions/:interventionId/complete')
  completeIntervention(
    @CurrentUser('id') userId: number,
    @Param('interventionId', ParseIntPipe) interventionId: number,
  ) {
    return this.artisansService.completeIntervention(userId, interventionId);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.MISSIONS_WORK)
  @Post('me/missions/:interventionId/problem')
  reportProblem(
    @CurrentUser('id') userId: number,
    @Param('interventionId', ParseIntPipe) interventionId: number,
    @Body() dto: ReportProblemDto,
  ) {
    return this.artisansService.reportProblem(userId, interventionId, dto);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.MISSIONS_WORK)
  @Post('me/missions/:interventionId/contact-client')
  contactClient(
    @CurrentUser('id') userId: number,
    @Param('interventionId', ParseIntPipe) interventionId: number,
    @Body() dto: ContactMessageDto,
  ) {
    return this.artisansService.contactClient(userId, interventionId, dto);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.MISSIONS_WORK)
  @Post('me/missions/:interventionId/contact-admin')
  contactAdmin(
    @CurrentUser('id') userId: number,
    @Param('interventionId', ParseIntPipe) interventionId: number,
    @Body() dto: ContactMessageDto,
  ) {
    return this.artisansService.contactAdmin(userId, interventionId, dto);
  }
}
