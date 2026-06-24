import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { UsersService } from './users.service';

import { CreateUserDto } from './dto/create-user.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateUserAdminDto } from './dto/update-user-admin.dto';

import { Role } from '../../../generated/prisma/client';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // ==========================================================
  // 1. CURRENT USER PROFILE
  // These routes are for the logged-in user.
  // ==========================================================

  // GET /users/me
  @UseGuards(JwtAuthGuard)
  @Get('me')
  getMe(@CurrentUser('id') userId: number) {
    return this.usersService.getProfile(userId);
  }

  // PATCH /users/me
  @UseGuards(JwtAuthGuard)
  @Patch('me')
  updateMe(
    @CurrentUser('id') userId: number,
    @Body() updateData: UpdateProfileDto,
  ) {
    return this.usersService.updateProfile(userId, updateData);
  }

  // DELETE /users/me
  // Soft delete / deactivate current account
  @UseGuards(JwtAuthGuard)
  @Delete('me')
  deleteMe(@CurrentUser('id') userId: number) {
    return this.usersService.deactivateAccount(userId);
  }

  // ==========================================================
  // 2. BACKWARD COMPATIBILITY ROUTES
  // Keep these because your current Admin Dashboard may use:
  // GET /users/profile and PATCH /users/profile
  // ==========================================================

  // GET /users/profile
  @UseGuards(JwtAuthGuard)
  @Get('profile')
  getProfile(@CurrentUser('id') userId: number) {
    return this.usersService.getProfile(userId);
  }

  // PATCH /users/profile
  @UseGuards(JwtAuthGuard)
  @Patch('profile')
  updateProfile(
    @CurrentUser('id') userId: number,
    @Body() updateData: UpdateProfileDto,
  ) {
    return this.usersService.updateProfile(userId, updateData);
  }

  // ==========================================================
  // 3. ARTISAN ROUTES
  // These routes must come BEFORE /users/:id
  // ==========================================================

  // GET /users/artisans
  // Used by Admin Dashboard to populate artisan dropdown/list
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
  )
  @Get('artisans')
  findArtisans(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    const where: any = {
      role: Role.ARTISAN,
      deletedAt: null,
    };

    if (search) {
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } },
        { name: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
      ];
    }

    return this.usersService.findAll({
      where,
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 50,
    });
  }

  // POST /users/artisans/create
  // Used by the Admin Dashboard "Add Technician" modal
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Post('artisans/create')
  async createArtisan(
    @Body()
    body: {
      name: string;
      email: string;
      phone: string;
      specialty?: string;
    },
  ) {
    return this.usersService.createArtisanDirectly(body);
  }

  // ==========================================================
  // 4. STAFF ROUTES
  // For SUPPORT / DISPATCHER / ACCOUNTANT / ADMIN users
  // ==========================================================

  // POST /users/staff/create
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  @Post('staff/create')
  async createStaffUser(
    @Body()
    body: {
      name: string;
      email: string;
      phone?: string;
      role: Role;
    },
  ) {
    return this.usersService.createStaffUser(body);
  }

  // ==========================================================
  // 5. LOCATION ROUTE
  // Used by the artisan mobile app to update GPS position
  // Must come BEFORE /users/:id
  // ==========================================================

  // PATCH /users/location
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ARTISAN, Role.ADMIN, Role.SUPER_ADMIN)
  @Patch('location')
  updateLocation(
    @CurrentUser('id') userId: number,
    @Body()
    body: {
      latitude: number;
      longitude: number;
    },
  ) {
    return this.usersService.updateLocation(
      userId,
      body.latitude,
      body.longitude,
    );
  }

  // ==========================================================
  // 6. ADMIN USER MANAGEMENT
  // ==========================================================

  // POST /users
  // Admin creates a user manually
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Post()
  create(@Body() createUserDto: CreateUserDto) {
    return this.usersService.createByAdmin(createUserDto);
  }

  // GET /users?page=1&limit=20&role=CLIENT&search=test
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
    Role.ACCOUNTANT,
  )
  @Get()
  findAll(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('role') role?: Role,
    @Query('search') search?: string,
    @Query('includeDeleted') includeDeleted?: string,
  ) {
    const where: any = {};

    if (includeDeleted !== 'true') {
      where.deletedAt = null;
    }

    if (role) {
      where.role = role;
    }

    if (search) {
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } },
        { name: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
      ];
    }

    return this.usersService.findAll({
      where,
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 20,
    });
  }

  // GET /users/:id
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
    Role.ACCOUNTANT,
  )
  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.usersService.getProfile(id);
  }

  // PATCH /users/:id
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Patch(':id')
  update(
    @CurrentUser('id') currentUserId: number,
    @CurrentUser('role') currentUserRole: Role,
    @Param('id', ParseIntPipe) id: number,
    @Body() updateUserDto: UpdateUserAdminDto,
  ) {
    // Security: ADMIN cannot edit SUPER_ADMIN.
    // Only SUPER_ADMIN can manage SUPER_ADMIN accounts.
    if (
      updateUserDto.role === Role.SUPER_ADMIN &&
      currentUserRole !== Role.SUPER_ADMIN
    ) {
      throw new ForbiddenException(
        'Seul un SUPER_ADMIN peut attribuer le rôle SUPER_ADMIN.',
      );
    }

    // Security: normal ADMIN should not edit themselves into SUPER_ADMIN.
    if (
      id === currentUserId &&
      updateUserDto.role === Role.SUPER_ADMIN &&
      currentUserRole !== Role.SUPER_ADMIN
    ) {
      throw new ForbiddenException(
        'Vous ne pouvez pas vous attribuer ce rôle.',
      );
    }

    return this.usersService.updateByAdmin(id, updateUserDto);
  }

  // DELETE /users/:id
  // Soft delete / deactivate user
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Delete(':id')
  remove(
    @CurrentUser('id') currentUserId: number,
    @CurrentUser('role') currentUserRole: Role,
    @Param('id', ParseIntPipe) id: number,
  ) {
    // Security: users should not deactivate themselves from admin route
    if (currentUserId === id) {
      throw new ForbiddenException(
        'Vous ne pouvez pas désactiver votre propre compte depuis cette route.',
      );
    }

    return this.usersService.remove(id);
  }

  // PATCH /users/:id/reactivate
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Patch(':id/reactivate')
  reactivateUser(@Param('id', ParseIntPipe) id: number) {
    return this.usersService.reactivateUser(id);
  }
}