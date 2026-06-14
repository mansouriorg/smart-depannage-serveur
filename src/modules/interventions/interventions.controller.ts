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
  BadRequestException
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';

import { InterventionsService } from './interventions.service';
import { CreateInterventionDto } from './dto/create-intervention.dto';
import { UpdateInterventionDto } from './dto/update-intervention.dto';
import { AuthGuard } from '@nestjs/passport';

@Controller('interventions')
export class InterventionsController {
  constructor(private readonly interventionsService: InterventionsService) {}

  // ==========================================================
  // 1. PUBLIC ROUTE: Create Request (GUESTS)
  // ==========================================================
  @Post()
  create(@Request() req, @Body() createInterventionDto: CreateInterventionDto) {
    return this.interventionsService.create(null, createInterventionDto);
  }

  // ==========================================================
  // 2. SECURE ROUTE: Create Request (LOGGED IN USERS)
  // ==========================================================
  @Post('secure')
  @UseGuards(AuthGuard('jwt'))
  createSecure(@Request() req, @Body() createInterventionDto: CreateInterventionDto) {
    return this.interventionsService.create(req.user.userId, createInterventionDto);
  }

  // ==========================================================
  // 3. NEW ROUTE: My Assigned Missions (For Artisans) 👷‍♂️
  // ==========================================================
  // ✅ MUST be placed BEFORE @Get(':id') to avoid conflicts
  @Get('assigned')
  @UseGuards(AuthGuard('jwt')) 
  findAssigned(@Request() req) {
    // Only Artisans should call this, but the query handles it safely
    return this.interventionsService.findByArtisan(req.user.userId);
  }

  // ==========================================================
  // 4. GENERAL ROUTES: Reading (Marketplace / Admin / History)
  // ==========================================================

  // GET /interventions
  @Get()
  @UseGuards(AuthGuard('jwt'))
  findAll(@Request() req) {
    // Logic: Admins see everything
    if (req.user.role === 'ADMIN') {
      return this.interventionsService.findAll();
    }
    // Artisans see "Pending" jobs (Marketplace)
    if (req.user.role === 'ARTISAN') {
      return this.interventionsService.findAllPending();
    }
    
    // Clients see only their own history
    return this.interventionsService.findByUser(req.user.userId);
  }

  // GET /interventions/:id (Get details)
  @Get(':id')
  @UseGuards(AuthGuard('jwt'))
  findOne(@Param('id') id: string) {
    return this.interventionsService.findOne(+id);
  }

  // ==========================================================
  // 5. UPDATE ROUTE: (Assign Artisan / Change Status)
  // ==========================================================
  @Patch(':id')
  @UseGuards(AuthGuard('jwt'))
  update(
    @Request() req, 
    @Param('id') id: string, 
    @Body() updateInterventionDto: UpdateInterventionDto
  ) {
    // Security: Clients cannot update interventions directly
    if (req.user.role === 'CLIENT') {
       throw new ForbiddenException('Clients cannot update interventions directly');
    }
    return this.interventionsService.update(+id, updateInterventionDto);
  }

  // ==========================================================
  // 6. 📸 SECURE ROUTE: Tamper-Proof Proof of Work Upload
  // ==========================================================
  @Post(':id/complete-work')
  @UseGuards(AuthGuard('jwt'))
  @UseInterceptors(FileInterceptor('photo', {
    storage: diskStorage({
      destination: './uploads/proofs', // Ensure this folder exists at the root of your project!
      filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        const ext = extname(file.originalname);
        cb(null, `proof-${uniqueSuffix}${ext}`);
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

    // Convert string inputs from FormData back into proper data types
    const proofData = {
      photoUrl: `/uploads/proofs/${file.filename}`,
      latitude: parseFloat(latitude),
      longitude: parseFloat(longitude),
      timestamp: new Date(timestamp),
    };

    return this.interventionsService.completeWork(+id, proofData);
  }
}