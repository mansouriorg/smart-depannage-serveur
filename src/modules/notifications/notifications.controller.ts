import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';

import { NotificationsService } from './notifications.service';

import { CreateNotificationDto } from './dto/create-notification.dto';
import { UpdateNotificationDto } from './dto/update-notification.dto';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

import { Role } from '../../../generated/prisma/client';

type AuthenticatedUser = {
  id: number;
  role: Role;
};

type RegisterPushTokenBody = {
  token: string;
  platform?: string;
  deviceId?: string;
  deviceName?: string;
};

type UpdateNotificationPreferencesBody = {
  inAppEnabled?: boolean;
  emailEnabled?: boolean;
  smsEnabled?: boolean;
  pushEnabled?: boolean;
  adminRealtimeEnabled?: boolean;

  interventionUpdates?: boolean;
  quoteUpdates?: boolean;
  paymentUpdates?: boolean;
  invoiceUpdates?: boolean;
  complaintUpdates?: boolean;
  marketingUpdates?: boolean;

  newInterventionCreated?: boolean;
  artisanAssigned?: boolean;
  artisanAcceptedMission?: boolean;
  artisanOnTheWay?: boolean;
  artisanArrived?: boolean;
  workStarted?: boolean;
  workCompleted?: boolean;
  quoteSent?: boolean;
  quoteAccepted?: boolean;
  paymentReceived?: boolean;
  invoiceReady?: boolean;
  complaintOpened?: boolean;
  complaintUpdated?: boolean;
  artisanApplicationApproved?: boolean;
  artisanApplicationRejected?: boolean;
};

@Controller('notifications')
@UseGuards(JwtAuthGuard, RolesGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  // ==========================================================
  // 1. ADMIN - CREATE NOTIFICATION MANUALLY
  // Keeps your old POST /notifications route
  // ==========================================================

  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.SUPPORT)
  @Post()
  create(@Body() createNotificationDto: CreateNotificationDto) {
    return this.notificationsService.create(createNotificationDto);
  }

  // ==========================================================
  // 2. ADMIN - LIST ALL NOTIFICATIONS
  // Keeps your old GET /notifications route
  // ==========================================================

  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.SUPPORT, Role.ACCOUNTANT)
  @Get()
  findAll() {
    return this.notificationsService.findAll();
  }

  // ==========================================================
  // 3. NOTIFICATION CENTER - MY NOTIFICATIONS
  // ==========================================================

  @Roles(
    Role.CLIENT,
    Role.ARTISAN,
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
    Role.ACCOUNTANT,
  )
  @Get('mine')
  findMine(@CurrentUser() user: AuthenticatedUser) {
    return this.notificationsService.findMine(user);
  }

  // ==========================================================
  // 4. NOTIFICATION CENTER - UNREAD COUNT
  // Must stay before GET /notifications/:notificationId
  // ==========================================================

  @Roles(
    Role.CLIENT,
    Role.ARTISAN,
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
    Role.ACCOUNTANT,
  )
  @Get('unread/count')
  countUnread(@CurrentUser() user: AuthenticatedUser) {
    return this.notificationsService.countUnread(user);
  }

  // ==========================================================
  // 5. NOTIFICATION CENTER - UNREAD
  // ==========================================================

  @Roles(
    Role.CLIENT,
    Role.ARTISAN,
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
    Role.ACCOUNTANT,
  )
  @Get('unread')
  findUnread(@CurrentUser() user: AuthenticatedUser) {
    return this.notificationsService.findUnread(user);
  }

  // ==========================================================
  // 6. NOTIFICATION CENTER - READ
  // ==========================================================

  @Roles(
    Role.CLIENT,
    Role.ARTISAN,
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
    Role.ACCOUNTANT,
  )
  @Get('read')
  findRead(@CurrentUser() user: AuthenticatedUser) {
    return this.notificationsService.findRead(user);
  }

  // ==========================================================
  // 7. PREFERENCES
  // Must stay before GET /notifications/:notificationId
  // ==========================================================

  @Roles(
    Role.CLIENT,
    Role.ARTISAN,
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
    Role.ACCOUNTANT,
  )
  @Get('preferences/me')
  getMyPreferences(@CurrentUser() user: AuthenticatedUser) {
    return this.notificationsService.getMyPreferences(user);
  }

  @Roles(
    Role.CLIENT,
    Role.ARTISAN,
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
    Role.ACCOUNTANT,
  )
  @Patch('preferences/me')
  updateMyPreferences(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateNotificationPreferencesBody,
  ) {
    return this.notificationsService.updateMyPreferences(user, dto);
  }

  // ==========================================================
  // 8. PUSH TOKENS
  // Used later for real mobile push notifications
  // ==========================================================

  @Roles(
    Role.CLIENT,
    Role.ARTISAN,
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
    Role.ACCOUNTANT,
  )
  @Post('push-tokens')
  registerPushToken(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RegisterPushTokenBody,
  ) {
    return this.notificationsService.registerPushToken(user, dto);
  }

  @Roles(
    Role.CLIENT,
    Role.ARTISAN,
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
    Role.ACCOUNTANT,
  )
  @Delete('push-tokens/:token')
  deactivatePushToken(
    @CurrentUser() user: AuthenticatedUser,
    @Param('token') token: string,
  ) {
    return this.notificationsService.deactivatePushToken(user, token);
  }

  // ==========================================================
  // 9. MARK ALL AS READ
  // Must stay before PATCH /notifications/:notificationId/read
  // ==========================================================

  @Roles(
    Role.CLIENT,
    Role.ARTISAN,
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
    Role.ACCOUNTANT,
  )
  @Patch('read-all')
  markAllAsRead(@CurrentUser() user: AuthenticatedUser) {
    return this.notificationsService.markAllAsRead(user);
  }

  // ==========================================================
  // 10. ADMIN - OLD UPDATE ROUTE COMPATIBILITY
  // Keeps your old PATCH /notifications/:id route
  // ==========================================================

  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.SUPPORT)
  @Patch(':notificationId')
  update(
    @Param('notificationId', ParseIntPipe) notificationId: number,
    @Body() updateNotificationDto: UpdateNotificationDto,
  ) {
    return this.notificationsService.update(
      notificationId,
      updateNotificationDto,
    );
  }

  // ==========================================================
  // 11. MARK ONE AS READ
  // ==========================================================

  @Roles(
    Role.CLIENT,
    Role.ARTISAN,
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
    Role.ACCOUNTANT,
  )
  @Patch(':notificationId/read')
  markAsRead(
    @CurrentUser() user: AuthenticatedUser,
    @Param('notificationId', ParseIntPipe) notificationId: number,
  ) {
    return this.notificationsService.markAsRead(user, notificationId);
  }

  // ==========================================================
  // 12. NOTIFICATION DETAILS
  // Must stay after all specific GET routes
  // ==========================================================

  @Roles(
    Role.CLIENT,
    Role.ARTISAN,
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
    Role.ACCOUNTANT,
  )
  @Get(':notificationId')
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('notificationId', ParseIntPipe) notificationId: number,
  ) {
    return this.notificationsService.findOne(user, notificationId);
  }

  // ==========================================================
  // 13. DELETE NOTIFICATION
  // Soft delete for users/admins
  // ==========================================================

  @Roles(
    Role.CLIENT,
    Role.ARTISAN,
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
    Role.ACCOUNTANT,
  )
  @Delete(':notificationId')
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('notificationId', ParseIntPipe) notificationId: number,
  ) {
    return this.notificationsService.deleteNotification(user, notificationId);
  }
}