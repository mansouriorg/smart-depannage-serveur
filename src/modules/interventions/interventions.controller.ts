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
// 🔒 1. Protect this entire controller. User must be logged in.
@UseGuards(AuthGuard('jwt')) 
export class InterventionsController {
  constructor(private readonly interventionsService: InterventionsService) {}

  // POST /interventions (Create a request)
  @Post()
  create(@Request() req, @Body() createInterventionDto: CreateInterventionDto) {
    // We get the userId from the token (req.user)
    return this.interventionsService.create(req.user.userId, createInterventionDto);
  }

  // GET /interventions (List requests)
  @Get()
  findAll(@Request() req) {
    // 2. Logic: Admins see everything, Clients see only their own
    if (req.user.role === 'ADMIN') {
      return this.interventionsService.findAll();
    }
    // If it's an Artisan, we might want to show "Pending" jobs (Nearby logic later)
    if (req.user.role === 'ARTISAN') {
      return this.interventionsService.findAllPending();
    }
    
    return this.interventionsService.findByUser(req.user.userId);
  }

  // GET /interventions/:id (Get details)
  @Get(':id')
  findOne(@Param('id') id: string) {
    // Use +id to convert string "1" to number 1
    return this.interventionsService.findOne(+id);
  }

  // PATCH /interventions/:id (Update status/assign artisan)
  @Patch(':id')
  update(
    @Request() req, 
    @Param('id') id: string, 
    @Body() updateInterventionDto: UpdateInterventionDto
  ) {
    // 3. Security: Only Admin or Artisan should be able to update status
    if (req.user.role === 'CLIENT') {
       throw new ForbiddenException('Clients cannot update interventions directly');
    }
    return this.interventionsService.update(+id, updateInterventionDto);
  }
}