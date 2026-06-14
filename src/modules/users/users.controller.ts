import { 
  Controller, 
  Get, 
  Post, 
  Body, 
  Patch, 
  Param, 
  Delete, 
  UseGuards, 
  Request,
  ForbiddenException // ✅ Added for Admin security check
} from '@nestjs/common';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { AuthGuard } from '@nestjs/passport';

// ⚠️ Import 'Role' from your custom generated path
import { Role } from '../../../generated/prisma/client'; 

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // ==========================================================
  // 1. SPECIFIC ROUTES (Must come BEFORE :id)
  // ==========================================================
  
  // ✅ GET /users/artisans
  // Used to populate the dropdown & list in the Admin Dashboard
  @Get('artisans')
  @UseGuards(AuthGuard('jwt'))
  findArtisans() {
    return this.usersService.findAll({ where: { role: Role.ARTISAN } });
  }

  // ✅ POST /users/artisans/create
  // Used by the Next.js "Add Technician" modal to create an account instantly
  @Post('artisans/create')
  @UseGuards(AuthGuard('jwt'))
  async createArtisan(
    @Request() req, 
    @Body() body: { name: string; email: string; phone: string; specialty?: string }
  ) {
    // 🔒 Security Check: Only Admins can create technicians directly bypassing the application process
    if (req.user.role !== 'ADMIN') {
      throw new ForbiddenException('Seuls les administrateurs peuvent ajouter des techniciens.');
    }
    return this.usersService.createArtisanDirectly(body);
  }

  // ✅ PATCH /users/location
  // Used by the Mobile App to update GPS position
  // ⚠️ MUST be defined BEFORE @Get(':id')
  @Patch('location')
  @UseGuards(AuthGuard('jwt'))
  updateLocation(@Request() req, @Body() body: { latitude: number; longitude: number }) {
    // req.user.userId comes from the JWT token
    console.log(`Updating location for user ${req.user.userId}:`, body);
    return this.usersService.updateLocation(+req.user.userId, body.latitude, body.longitude);
  }

  // ==========================================================
  // 2. STANDARD CRUD ROUTES
  // ==========================================================

  @Post()
  create(@Body() createUserDto: CreateUserDto) {
    return this.usersService.create(createUserDto);
  }

  @Get()
  @UseGuards(AuthGuard('jwt'))
  findAll() {
    return this.usersService.findAll();
  }

  // ⚠️ This matches /users/1, /users/2, etc.
  @Get(':id')
  @UseGuards(AuthGuard('jwt'))
  findOne(@Param('id') id: string) {
    return this.usersService.findOne(+id);
  }

  @Patch(':id')
  @UseGuards(AuthGuard('jwt'))
  update(@Param('id') id: string, @Body() updateUserDto: UpdateUserDto) {
    return this.usersService.update(+id, updateUserDto);
  }

  // ✅ DELETE /users/:id
  // This performs a "Soft Delete" (Ban) by setting isActive = false.
  @Delete(':id')
  @UseGuards(AuthGuard('jwt'))
  remove(@Param('id') id: string) {
    return this.usersService.remove(+id);
  }
}