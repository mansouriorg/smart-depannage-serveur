import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  Request,
  ForbiddenException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import { InterventionsService } from './interventions.service';
import { CreateInterventionDto } from './dto/create-intervention.dto';
import { AuthGuard } from '@nestjs/passport';
import { isTicketStaff } from '../../common/auth/role-policy';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Permission } from '../../common/auth/permissions';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { PROOF_UPLOAD } from '../proofs/proof-upload';
import { AddProofDto } from '../proofs/dto/proofs.dto';
import { RateLimit, RateLimitGuard } from '../../common/rate-limit/rate-limit.guard';

/**
 * The four routes of the first version of the interventions API that a screen still calls (P3-03). Everything else this controller
 * used to answer (the public request form, the list, one job, the update, the three tracking-link routes) was deleted when no screen
 * called it any more: the website uses `/guest/...`, a customer `/client/interventions`, the technician `/artisans/me/missions/...`
 * and the back office `/admin/interventions/...`.
 *
 * `legacy-routes.spec.ts` keeps the list of what remains and which screen calls it. Delete a route here only after that screen has
 * moved off it:
 *
 *   POST /interventions/secure             dashboard, "create a ticket"            no replacement for the back office yet
 *   GET  /interventions/assigned           phone app, home and missions tabs       GET /artisans/me/missions (another answer)
 *   GET  /interventions/dashboard/stats    dashboard home                          GET /admin/dashboard/kpis (another answer)
 *   POST /interventions/:id/complete-work  phone app, finish the job with a photo  POST /interventions/:id/proofs/after, then
 *                                                                                  PATCH /artisans/me/missions/:id/complete (two calls)
 */
@Controller('interventions')
export class InterventionsController {
  constructor(private readonly interventionsService: InterventionsService) {}

  // Creates a request for the signed-in account (the dashboard's "create a ticket" sends it).
  @Post('secure')
  @UseGuards(AuthGuard('jwt'), RateLimitGuard)
  @RateLimit({ name: 'secure-create', limit: 60, windowMs: 60 * 60_000 })
  createSecure(@Request() req, @Body() createInterventionDto: CreateInterventionDto) {
    return this.interventionsService.create(req.user.id, createInterventionDto, req.user.role);
  }

  // The jobs of the signed-in artisan, newest first (the phone app's lists).
  @Get('assigned')
  @UseGuards(AuthGuard('jwt'))
  findAssigned(@Request() req) {
    // Only Artisans should call this, but the query handles it safely
    return this.interventionsService.findByArtisan(req.user.id);
  }

  // The numbers of the dashboard's home page.
  @Get('dashboard/stats')
  @UseGuards(AuthGuard('jwt'))
  getDashboardStats(@Request() req) {
    if (!isTicketStaff(req.user.role)) {
      throw new ForbiddenException('Seuls les administrateurs ont accès aux statistiques.');
    }
    return this.interventionsService.getDashboardStats();
  }

  // ==========================================================
  // Tamper-proof proof of work: the artisan closes the job with the "after" photo.
  // ==========================================================
  // multipart: photo, latitude, longitude, accuracy (metres), mocked (true/false), timestamp.
  // The photo is received in memory (never in a folder the web server could serve) and judged by
  // the proof service (P1-07) before anything is kept.
  @RequirePermission(Permission.MISSIONS_WORK)
  @Post(':id/complete-work')
  // The role is checked BEFORE the interceptor reads the photo.
  @UseGuards(AuthGuard('jwt'), PermissionsGuard)
  @UseInterceptors(FileInterceptor('photo', PROOF_UPLOAD))
  async completeWork(
    @Request() req,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: AddProofDto,
  ) {
    return this.interventionsService.completeWork(
      +id,
      { id: req.user.id, role: req.user.role },
      {
        file,
        capture: { ...body, capturedAt: body?.capturedAt ?? body?.timestamp },
      },
    );
  }
}
