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
// ❌ REMOVED: @UseGuards(AuthGuard('jwt')) from here. 
// The Controller is now open so Guests can access the POST route.
export class InterventionsController {
  constructor(private readonly interventionsService: InterventionsService) {}

  // ==========================================================
  // 1. PUBLIC ROUTE: Create Request
  // ==========================================================
  // We do NOT add @UseGuards here so guests can use it.
  @Post()
  create(@Request() req, @Body() createInterventionDto: CreateInterventionDto) {
    // If the user is logged in (and you have a passive guard), req.user exists.
    // If it's a guest, req.user is undefined.
    // The Service now handles 'null' by creating a Guest User automatically.
    const userId = req.user ? req.user.userId : null;
    
    return this.interventionsService.create(userId, createInterventionDto);
  }

  // ==========================================================
  // 2. PROTECTED ROUTES: Only for Logged-in Users
  // ==========================================================

  // GET /interventions (List requests)
  @Get()
  @UseGuards(AuthGuard('jwt')) // 🔒 PROTECTED
  findAll(@Request() req) {
    // Logic: Admins see everything, Clients see only their own
    if (req.user.role === 'ADMIN') {
      return this.interventionsService.findAll();
    }
    // If it's an Artisan, show "Pending" jobs
    if (req.user.role === 'ARTISAN') {
      return this.interventionsService.findAllPending();
    }
    
    // Clients see their own history
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
    // Security: Only Admin or Artisan should be able to update status
    if (req.user.role === 'CLIENT') {
       throw new ForbiddenException('Clients cannot update interventions directly');
    }
    return this.interventionsService.update(+id, updateInterventionDto);
  }
}