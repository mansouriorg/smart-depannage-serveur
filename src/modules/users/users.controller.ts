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
import { ContactChangeService } from './contact-change.service';
import { artisanListWhere, artisanPageSize } from './artisan-list-filter';

import { CreateUserDto } from './dto/create-user.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateUserAdminDto } from './dto/update-user-admin.dto';
import { ChangeEmailDto } from './dto/change-email.dto';
import { ConfirmEmailChangeDto } from './dto/confirm-email-change.dto';
import { ChangePhoneDto } from './dto/change-phone.dto';
import { ConfirmPhoneChangeDto } from './dto/confirm-phone-change.dto';

import { Role } from '../../../generated/prisma/client';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { canManage } from '../../common/auth/role-policy';
import {
  RateLimit,
  RateLimitGuard,
} from '../../common/rate-limit/rate-limit.guard';

@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly contactChange: ContactChangeService,
  ) {}

  /**
   * P0-08: hierarchy check for every admin action on another account.
   * An ADMIN cannot touch a SUPER_ADMIN (or another ADMIN), and cannot give
   * out a role equal to or above their own. SUPER_ADMIN can manage everyone.
   */
  private async assertCanManageUser(
    actorRole: Role,
    targetId: number,
    newRole?: Role,
  ): Promise<void> {
    const target = await this.usersService.findOne(targetId); // 404 if unknown

    if (!canManage(actorRole, target.role, newRole)) {
      throw new ForbiddenException(
        'Vous n’avez pas les droits nécessaires sur ce compte ou sur ce rôle.',
      );
    }
  }

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

  // ----------------------------------------------------------
  // Changing the e-mail address or the phone number (P1-03, step 4).
  // PATCH /users/me no longer changes them: it answers 400 with the code
  // CONTACT_CHANGE_REQUIRES_VERIFICATION and the app calls these routes.
  // ----------------------------------------------------------

  // POST /users/me/email-change   { newEmail, currentPassword }
  // Sends a link to the NEW address. Nothing changes before it is clicked.
  @UseGuards(JwtAuthGuard, RateLimitGuard)
  @RateLimit({ name: 'email-change', limit: 10, windowMs: 60 * 60_000 })
  @Post('me/email-change')
  requestEmailChange(
    @CurrentUser('id') userId: number,
    @Body() dto: ChangeEmailDto,
  ) {
    return this.contactChange.requestEmailChange(userId, dto);
  }

  // POST /users/email-change/confirm   { token }
  // Public on purpose: the link is opened from a mailbox, often on another
  // device than the one that is logged in. The token is the proof.
  @UseGuards(RateLimitGuard)
  @RateLimit({ name: 'email-change-confirm', limit: 20, windowMs: 15 * 60_000 })
  @Post('email-change/confirm')
  confirmEmailChange(@Body() dto: ConfirmEmailChangeDto) {
    return this.contactChange.confirmEmailChange(dto.token);
  }

  // POST /users/me/phone-change   { newPhone, currentPassword }
  // Sends a 6-digit code by SMS to the NEW number.
  @UseGuards(JwtAuthGuard, RateLimitGuard)
  @RateLimit({ name: 'phone-change', limit: 10, windowMs: 60 * 60_000 })
  @Post('me/phone-change')
  requestPhoneChange(
    @CurrentUser('id') userId: number,
    @Body() dto: ChangePhoneDto,
  ) {
    return this.contactChange.requestPhoneChange(userId, dto);
  }

  // POST /users/me/phone-change/confirm   { code }
  @UseGuards(JwtAuthGuard, RateLimitGuard)
  @RateLimit({ name: 'phone-change-confirm', limit: 20, windowMs: 15 * 60_000 })
  @Post('me/phone-change/confirm')
  confirmPhoneChange(
    @CurrentUser('id') userId: number,
    @Body() dto: ConfirmPhoneChangeDto,
  ) {
    return this.contactChange.confirmPhoneChange(userId, dto.code);
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
    // ?assignable=true: only the artisans a job can be given to (P1-05)
    @Query('assignable') assignable?: string,
  ) {
    return this.usersService.findAll({
      where: artisanListWhere({ search, assignable }) as any,
      page: page ? Number(page) : 1,
      limit: artisanPageSize(limit),
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
  create(
    @CurrentUser('role') currentUserRole: Role,
    @Body() createUserDto: CreateUserDto,
  ) {
    // P0-08: the role of the new account must be below the creator's own.
    // (default role is CLIENT when none is given)
    if (!canManage(currentUserRole, createUserDto.role ?? Role.CLIENT)) {
      throw new ForbiddenException(
        'Vous ne pouvez pas créer un compte avec ce rôle.',
      );
    }

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
  async update(
    @CurrentUser('id') currentUserId: number,
    @CurrentUser('role') currentUserRole: Role,
    @Param('id', ParseIntPipe) id: number,
    @Body() updateUserDto: UpdateUserAdminDto,
  ) {
    // P0-08: hierarchy check on the target account AND on the role given.
    await this.assertCanManageUser(currentUserRole, id, updateUserDto.role);

    // Nobody locks themselves out through the admin route (use /users/me).
    if (
      id === currentUserId &&
      ((updateUserDto.role && updateUserDto.role !== currentUserRole) ||
        updateUserDto.isActive === false)
    ) {
      throw new ForbiddenException(
        'Vous ne pouvez pas modifier votre propre rôle ou désactiver votre propre compte.',
      );
    }

    return this.usersService.updateByAdmin(id, updateUserDto, {
      actorId: currentUserId,
    });
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

    return this.assertCanManageUser(currentUserRole, id).then(() =>
      this.usersService.remove(id),
    );
  }

  // POST /users/:id/password-setup-link
  // New one-time link to choose a password. While e-mail delivery is simulated
  // the link is returned here so the admin can hand it over.
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Post(':id/password-setup-link')
  async reissuePasswordSetupLink(
    @CurrentUser('id') currentUserId: number,
    @CurrentUser('role') currentUserRole: Role,
    @Param('id', ParseIntPipe) id: number,
  ) {
    // Same hierarchy as editing the account: whoever holds the link can set the
    // password, so an ADMIN must not get one for an ADMIN or a SUPER_ADMIN.
    if (id !== currentUserId) {
      await this.assertCanManageUser(currentUserRole, id);
    } else {
      throw new ForbiddenException(
        'Utilisez « Mot de passe oublié » ou « Changer le mot de passe » pour votre propre compte.',
      );
    }

    return this.usersService.reissuePasswordSetupLink(id);
  }

  // PATCH /users/:id/reactivate
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Patch(':id/reactivate')
  async reactivateUser(
    @CurrentUser('role') currentUserRole: Role,
    @Param('id', ParseIntPipe) id: number,
  ) {
    await this.assertCanManageUser(currentUserRole, id);

    return this.usersService.reactivateUser(id);
  }
}
