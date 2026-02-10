import { 
  Controller, 
  Get, 
  Post, 
  Body, 
  Patch, 
  Param, 
  UseGuards, 
  Request, 
  ForbiddenException 
} from '@nestjs/common';
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
  // This route is open. Used by the Landing Page form.
  @Post()
  create(@Request() req, @Body() createInterventionDto: CreateInterventionDto) {
    // req.user is usually undefined here because there is no Guard
    return this.interventionsService.create(null, createInterventionDto);
  }

  // ==========================================================
  // 2. SECURE ROUTE: Create Request (LOGGED IN USERS)
  // ==========================================================
  // ✅ NEW: Used by Admin Dashboard & Client App
  // Because of @UseGuards, req.user is GUARANTEED to exist.
  @Post('secure')
  @UseGuards(AuthGuard('jwt'))
  createSecure(@Request() req, @Body() createInterventionDto: CreateInterventionDto) {
    return this.interventionsService.create(req.user.userId, createInterventionDto);
  }

  // ==========================================================
  // 3. PROTECTED ROUTES: Reading & Updating
  // ==========================================================

  // GET /interventions (List requests)
  @Get()
  @UseGuards(AuthGuard('jwt')) // 🔒 PROTECTED
  findAll(@Request() req) {
    // Logic: Admins see everything
    if (req.user.role === 'ADMIN') {
      return this.interventionsService.findAll();
    }
    // Artisans see "Pending" jobs to pick up
    if (req.user.role === 'ARTISAN') {
      return this.interventionsService.findAllPending();
    }
    
    // Clients see only their own history
    return this.interventionsService.findByUser(req.user.userId);
  }

  // GET /interventions/:id (Get details)
  @Get(':id')
  @UseGuards(AuthGuard('jwt')) // 🔒 PROTECTED
  findOne(@Param('id') id: string) {
    return this.interventionsService.findOne(+id);
  }

  // PATCH /interventions/:id (Update status/assign artisan)
  @Patch(':id')
  @UseGuards(AuthGuard('jwt')) // 🔒 PROTECTED
  update(
    @Request() req, 
    @Param('id') id: string, 
    @Body() updateInterventionDto: UpdateInterventionDto
  ) {
    // Security: Clients cannot update interventions directly (only cancel maybe, but we block for now)
    if (req.user.role === 'CLIENT') {
       throw new ForbiddenException('Clients cannot update interventions directly');
    }
    return this.interventionsService.update(+id, updateInterventionDto);
  }
}