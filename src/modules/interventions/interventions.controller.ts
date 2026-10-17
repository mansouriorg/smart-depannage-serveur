import { 
  Controller, 
  Get, 
  Post, 
  Body, 
  Patch, 
  Param, 
  UseGuards, 
  Request, 
  ForbiddenException,
  UploadedFile, 
  UseInterceptors, 
  BadRequestException,
  Query 
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import { InterventionsService } from './interventions.service';
import { CreateInterventionDto } from './dto/create-intervention.dto';
import { UpdateInterventionDto } from './dto/update-intervention.dto';
import { SubmitFeedbackDto } from './dto/submit-feedback.dto';
import { ReportIssueDto } from './dto/report-issue.dto'; 
import { AuthGuard } from '@nestjs/passport';
import { isTicketStaff } from '../../common/auth/role-policy';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Role } from '../../../generated/prisma/client';
import { PROOF_UPLOAD } from '../proofs/proof-upload';
import { AddProofDto } from '../proofs/dto/proofs.dto';
import {
  RateLimit,
  RateLimitGuard,
} from '../../common/rate-limit/rate-limit.guard';

@Controller('interventions')
export class InterventionsController {
  constructor(private readonly interventionsService: InterventionsService) {}

  // ==========================================================
  // 1. PUBLIC ROUTE: Create Request (GUESTS)
  // ==========================================================
  @Post()
  @UseGuards(RateLimitGuard)
  @RateLimit({ name: 'legacy-guest-create', limit: 10, windowMs: 60 * 60_000 })
  create(@Request() req, @Body() createInterventionDto: CreateInterventionDto) {
    return this.interventionsService.create(null, createInterventionDto);
  }

  // ==========================================================
  // 2. SECURE ROUTE: Create Request (LOGGED IN USERS)
  // ==========================================================
  @Post('secure')
  @UseGuards(AuthGuard('jwt'), RateLimitGuard)
  @RateLimit({ name: 'secure-create', limit: 60, windowMs: 60 * 60_000 })
  createSecure(@Request() req, @Body() createInterventionDto: CreateInterventionDto) {
    return this.interventionsService.create(req.user.id, createInterventionDto);
  }

  // ==========================================================
  // 3. NEW ROUTE: My Assigned Missions (For Artisans) 👷‍♂️
  // ==========================================================
  // ✅ MUST be placed BEFORE @Get(':id') to avoid conflicts
  @Get('assigned')
  @UseGuards(AuthGuard('jwt')) 
  findAssigned(@Request() req) {
    // Only Artisans should call this, but the query handles it safely
    return this.interventionsService.findByArtisan(req.user.id);
  }

  // ==========================================================
  // 4. GENERAL ROUTES: Reading (Marketplace / Admin / History)
  // ==========================================================

  // GET /interventions
  @Get()
  @UseGuards(AuthGuard('jwt'))
  findAll(@Request() req) {
    // Logic: back-office staff see everything (ADMIN, SUPER_ADMIN, SUPPORT, DISPATCHER)
    if (isTicketStaff(req.user.role)) {
      return this.interventionsService.findAll();
    }
    // Artisans see "Pending" jobs (Marketplace)
    if (req.user.role === 'ARTISAN') {
      return this.interventionsService.findAllPending(req.user.id);
    }
    
    // Clients see only their own history
    return this.interventionsService.findByUser(req.user.id);
  }

  // ==========================================================
  // 5. 📊 NEW ROUTE: Dashboard Stats (ADMIN)
  // ==========================================================
  // ⚠️ MUST be placed BEFORE @Get(':id') to avoid routing conflicts
  @Get('dashboard/stats')
  @UseGuards(AuthGuard('jwt'))
  getDashboardStats(@Request() req) {
    if (!isTicketStaff(req.user.role)) {
      throw new ForbiddenException('Seuls les administrateurs ont accès aux statistiques.');
    }
    return this.interventionsService.getDashboardStats();
  }

  // GET /interventions/:id (Get details)
  @Get(':id')
  @UseGuards(AuthGuard('jwt'))
  findOne(@Request() req, @Param('id') id: string) {
    // P0-16: the service checks that this user may see this ticket.
    return this.interventionsService.findOneForActor(+id, {
      id: req.user.id,
      role: req.user.role,
    });
  }

  // ==========================================================
  // 6. UPDATE ROUTE: (Assign Artisan / Change Status)
  // ==========================================================
  @Patch(':id')
  @UseGuards(AuthGuard('jwt'))
  update(
    @Request() req, 
    @Param('id') id: string, 
    @Body() updateInterventionDto: UpdateInterventionDto
  ) {
    // P0-16: staff manage tickets; an artisan may only advance their own
    // mission (en route / on site / in progress); everybody else is refused.
    if (isTicketStaff(req.user.role)) {
      return this.interventionsService.update(+id, updateInterventionDto, {
        kind: 'staff',
        userId: req.user.id,
      });
    }

    if (req.user.role === 'ARTISAN') {
      return this.interventionsService.updateAsArtisan(
        +id,
        req.user.id,
        updateInterventionDto,
      );
    }

    throw new ForbiddenException('Vous ne pouvez pas modifier cette intervention.');
  }

  // ==========================================================
  // 7. 📸 SECURE ROUTE: Tamper-Proof Proof of Work Upload
  // ==========================================================
  // multipart: photo, latitude, longitude, accuracy (metres), mocked (true/false), timestamp.
  // The photo is received in memory (never in a folder the web server could serve) and judged by
  // the proof service (P1-07) before anything is kept.
  @Post(':id/complete-work')
  // The role is checked BEFORE the interceptor reads the photo.
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(Role.ARTISAN)
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

  // ==========================================================
  // 8. 🔐 PUBLIC SECURE TRACKING: Read Status
  // ==========================================================
  // No @UseGuards here! The token provides the security.
  @Get('track/:id')
  async trackIntervention(
    @Param('id') id: string,
    @Query('token') token: string
  ) {
    if (!token) {
      throw new BadRequestException("Le token de suivi est obligatoire.");
    }
    return this.interventionsService.findByTrackingToken(+id, token);
  }

  // ==========================================================
  // 9. ⭐ PUBLIC SECURE TRACKING: Submit Feedback
  // ==========================================================
  // No @UseGuards here! The token provides the security.
  @Patch('track/:id/feedback')
  @UseGuards(RateLimitGuard)
  @RateLimit({ name: 'track-feedback', limit: 20, windowMs: 60 * 60_000 })
  async submitFeedback(
    @Param('id') id: string,
    @Query('token') token: string,
    @Body() submitFeedbackDto: SubmitFeedbackDto
  ) {
    if (!token) {
      throw new BadRequestException("Le token de suivi est obligatoire.");
    }
    return this.interventionsService.submitFeedback(+id, token, submitFeedbackDto);
  }

  // ==========================================================
  // 10. 🚨 PUBLIC SECURE TRACKING: Report an active issue
  // ==========================================================
  @Post('track/:id/issue')
  @UseGuards(RateLimitGuard)
  @RateLimit({ name: 'track-issue', limit: 10, windowMs: 60 * 60_000 })
  async reportActiveIssue(
    @Param('id') id: string,
    @Query('token') token: string,
    @Body() reportIssueDto: ReportIssueDto
  ) {
    if (!token) {
      throw new BadRequestException("Le token de suivi est obligatoire.");
    }
    return this.interventionsService.reportActiveIssue(+id, token, reportIssueDto.issueDescription);
  }
}
