import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards } from '@nestjs/common';
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
  // Used to populate the dropdown in the Admin Dashboard
  @Get('artisans')
  @UseGuards(AuthGuard('jwt'))
  findArtisans() {
    return this.usersService.findAll({ where: { role: Role.ARTISAN } });
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
  // If you put /users/artisans below this, it will break.
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

  @Delete(':id')
  @UseGuards(AuthGuard('jwt'))
  remove(@Param('id') id: string) {
    return this.usersService.remove(+id);
  }
}