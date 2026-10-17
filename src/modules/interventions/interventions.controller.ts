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
import { diskStorage } from 'multer';
import { open, unlink } from 'fs/promises';

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
import {
  RateLimit,
  RateLimitGuard,
} from '../../common/rate-limit/rate-limit.guard';

// Proof-of-work photos: images only, with the extension chosen by the server
// from the declared type (never from the client's file name), and a size cap.
// The folder is served publicly, so an .html or .svg upload would be a
// stored-XSS vector.
const PROOF_MAX_BYTES = 10 * 1024 * 1024;
const PROOF_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
};

/**
 * The declared MIME type comes from the client. Before keeping a file in a
 * publicly served folder, check that its first bytes really are those of a
 * JPEG, PNG, WebP or HEIC/HEIF image.
 */
async function looksLikeImage(path: string): Promise<boolean> {
  const handle = await open(path, 'r').catch(() => null);

  if (!handle) return false;

  try {
    const head = Buffer.alloc(12);
    await handle.read(head, 0, 12, 0);

    const isJpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    const isPng =
      head[0] === 0x89 && head.toString('latin1', 1, 4) === 'PNG';
    const isWebp =
      head.toString('latin1', 0, 4) === 'RIFF' &&
      head.toString('latin1', 8, 12) === 'WEBP';
    const isHeif = head.toString('latin1', 4, 8) === 'ftyp';

    return isJpeg || isPng || isWebp || isHeif;
  } finally {
    await handle.close();
  }
}

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
  @UseGuards(AuthGuard('jwt'))
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
      return this.interventionsService.findAllPending();
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
      return this.interventionsService.update(+id, updateInterventionDto);
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
  @Post(':id/complete-work')
  // The role is checked BEFORE the interceptor writes the file to disk.
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(Role.ARTISAN)
  @UseInterceptors(FileInterceptor('photo', {
    limits: { fileSize: PROOF_MAX_BYTES, files: 1 },
    fileFilter: (req, file, cb) => {
      if (PROOF_EXTENSIONS[file.mimetype]) {
        cb(null, true);
      } else {
        cb(new BadRequestException('La preuve doit être une photo (JPEG, PNG, WebP ou HEIC).'), false);
      }
    },
    storage: diskStorage({
      destination: './uploads/proofs', // Ensure this folder exists at the root of your project!
      filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, `proof-${uniqueSuffix}${PROOF_EXTENSIONS[file.mimetype] ?? '.jpg'}`);
      }
    })
  }))
  async completeWork(
    @Request() req,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('latitude') latitude: string,
    @Body('longitude') longitude: string,
    @Body('timestamp') timestamp: string,
  ) {
    // Basic Security: Only Artisans should be submitting proof of work
    if (req.user.role !== 'ARTISAN') {
      throw new ForbiddenException('Seuls les artisans peuvent soumettre une preuve de travail.');
    }

    if (!file) {
      throw new BadRequestException('La photo sécurisée est obligatoire.');
    }

    if (!(await looksLikeImage(file.path))) {
      await unlink(file.path).catch(() => undefined);
      throw new BadRequestException("Le fichier envoyé n'est pas une photo valide.");
    }

    // Convert string inputs from FormData back into proper data types
    const proofData = {
      photoUrl: `/uploads/proofs/${file.filename}`,
      latitude: parseFloat(latitude),
      longitude: parseFloat(longitude),
      timestamp: new Date(timestamp),
    };

    try {
      return await this.interventionsService.completeWork(+id, req.user.id, proofData);
    } catch (error) {
      // Rejected (not your mission, already closed...): do not leave the file
      // in a publicly served folder.
      await unlink(file.path).catch(() => undefined);
      throw error;
    }
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
