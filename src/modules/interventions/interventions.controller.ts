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

// ✅ IMPORT THE OPTIONAL GUARD
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';

@Controller('interventions')
export class InterventionsController {
  constructor(private readonly interventionsService: InterventionsService) {}

  // ==========================================================
  // 1. SMART ROUTE: Create Request (Guest OR Logged-in)
  // ==========================================================
  @Post()
  @UseGuards(OptionalJwtAuthGuard) // 👈 ADD THIS LINE
  create(@Request() req, @Body() createInterventionDto: CreateInterventionDto) {
    // Now, if a user sends a token, 'req.user' will be populated.
    // If not, 'req.user' is null, and the Service handles the guest logic.
    const userId = req.user ? req.user.userId : null;
    
    return this.interventionsService.create(userId, createInterventionDto);
  }

  // ==========================================================
  // 2. PROTECTED ROUTES: Only for Logged-in Users
  // ==========================================================

  @Get()
  @UseGuards(AuthGuard('jwt')) // 🔒 Strict Lock
  findAll(@Request() req) {
    if (req.user.role === 'ADMIN') {
      return this.interventionsService.findAll();
    }
    if (req.user.role === 'ARTISAN') {
      return this.interventionsService.findAllPending();
    }
    return this.interventionsService.findByUser(req.user.userId);
  }

  @Get(':id')
  @UseGuards(AuthGuard('jwt')) // 🔒 Strict Lock
  findOne(@Param('id') id: string) {
    return this.interventionsService.findOne(+id);
  }

  @Patch(':id')
  @UseGuards(AuthGuard('jwt')) // 🔒 Strict Lock
  update(
    @Request() req, 
    @Param('id') id: string, 
    @Body() updateInterventionDto: UpdateInterventionDto
  ) {
    // Security: Only Admin or Artisan should be able to update status
    if (req.user.role === 'CLIENT') {
       throw new ForbiddenException('Clients cannot update interventions directly');
    }
    return this.interventionsService.update(+id, updateInterventionDto);
  }
}