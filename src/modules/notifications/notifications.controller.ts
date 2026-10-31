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
import {
  RegisterPushTokenDto,
  TestDeliveryDto,
  UpdateNotificationPreferencesDto,
} from './dto/notification.dto';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Permission } from '../../common/auth/permissions';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

import { Role } from '../../../generated/prisma/client';

type AuthenticatedUser = {
  id: number;
  role: Role;
};

@Controller('notifications')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  // ==========================================================
  // 1. ADMIN - CREATE NOTIFICATION MANUALLY
  // Keeps your old POST /notifications route. The sender is always the caller.
  // ==========================================================

  @RequirePermission(Permission.NOTIFICATIONS_MANAGE)
  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() createNotificationDto: CreateNotificationDto,
  ) {
    return this.notificationsService.create(createNotificationDto, user);
  }

  // ==========================================================
  // 2. ADMIN - LIST ALL NOTIFICATIONS
  // Keeps your old GET /notifications route. Admin and super admin only: the
  // text of a notification can quote a chat.
  // ==========================================================

  @RequirePermission(Permission.NOTIFICATIONS_MANAGE)
  @Get()
  findAll() {
    return this.notificationsService.findAll();
  }

  // ==========================================================
  // 2b. ADMIN - CHECK THE DELIVERY SET-UP
  // Sends a test to the caller's own e-mail, phone or devices, then shows what
  // became of it (without the text). Both must stay before the :notificationId routes.
  // ==========================================================

  @RequirePermission(Permission.NOTIFICATIONS_MANAGE)
  @Post('test-delivery')
  testDelivery(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: TestDeliveryDto,
  ) {
    return this.notificationsService.testDelivery(user, dto.channel);
  }

  @RequirePermission(Permission.NOTIFICATIONS_MANAGE)
  @Get('outbox/:outboxId')
  outboxStatus(@Param('outboxId', ParseIntPipe) outboxId: number) {
    return this.notificationsService.outboxStatus(outboxId);
  }

  // ==========================================================
  // 3. NOTIFICATION CENTER - MY NOTIFICATIONS
  // ==========================================================

  @RequirePermission(Permission.NOTIFICATIONS_OWN)
  @Get('mine')
  findMine(@CurrentUser() user: AuthenticatedUser) {
    return this.notificationsService.findMine(user);
  }

  // ==========================================================
  // 4. NOTIFICATION CENTER - UNREAD COUNT
  // Must stay before GET /notifications/:notificationId
  // ==========================================================

  @RequirePermission(Permission.NOTIFICATIONS_OWN)
  @Get('unread/count')
  countUnread(@CurrentUser() user: AuthenticatedUser) {
    return this.notificationsService.countUnread(user);
  }

  // ==========================================================
  // 5. NOTIFICATION CENTER - UNREAD
  // ==========================================================

  @RequirePermission(Permission.NOTIFICATIONS_OWN)
  @Get('unread')
  findUnread(@CurrentUser() user: AuthenticatedUser) {
    return this.notificationsService.findUnread(user);
  }

  // ==========================================================
  // 6. NOTIFICATION CENTER - READ
  // ==========================================================

  @RequirePermission(Permission.NOTIFICATIONS_OWN)
  @Get('read')
  findRead(@CurrentUser() user: AuthenticatedUser) {
    return this.notificationsService.findRead(user);
  }

  // ==========================================================
  // 7. PREFERENCES
  // Must stay before GET /notifications/:notificationId
  // ==========================================================

  @RequirePermission(Permission.NOTIFICATIONS_OWN)
  @Get('preferences/me')
  getMyPreferences(@CurrentUser() user: AuthenticatedUser) {
    return this.notificationsService.getMyPreferences(user);
  }

  @RequirePermission(Permission.NOTIFICATIONS_OWN)
  @Patch('preferences/me')
  updateMyPreferences(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateNotificationPreferencesDto,
  ) {
    return this.notificationsService.updateMyPreferences(user, dto);
  }

  // ==========================================================
  // 8. PUSH TOKENS
  // Used later for real mobile push notifications
  // ==========================================================

  @RequirePermission(Permission.NOTIFICATIONS_OWN)
  @Post('push-tokens')
  registerPushToken(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RegisterPushTokenDto,
  ) {
    return this.notificationsService.registerPushToken(user, dto);
  }

  @RequirePermission(Permission.NOTIFICATIONS_OWN)
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

  @RequirePermission(Permission.NOTIFICATIONS_OWN)
  @Patch('read-all')
  markAllAsRead(@CurrentUser() user: AuthenticatedUser) {
    return this.notificationsService.markAllAsRead(user);
  }

  // ==========================================================
  // 10. ADMIN - OLD UPDATE ROUTE COMPATIBILITY
  // Keeps your old PATCH /notifications/:id route. Only the admin who sent the
  // notification, or a super admin, can correct it.
  // ==========================================================

  @RequirePermission(Permission.NOTIFICATIONS_MANAGE)
  @Patch(':notificationId')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('notificationId', ParseIntPipe) notificationId: number,
    @Body() updateNotificationDto: UpdateNotificationDto,
  ) {
    return this.notificationsService.update(
      user,
      notificationId,
      updateNotificationDto,
    );
  }

  // ==========================================================
  // 11. MARK ONE AS READ
  // ==========================================================

  @RequirePermission(Permission.NOTIFICATIONS_OWN)
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

  @RequirePermission(Permission.NOTIFICATIONS_OWN)
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

  @RequirePermission(Permission.NOTIFICATIONS_OWN)
  @Delete(':notificationId')
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('notificationId', ParseIntPipe) notificationId: number,
  ) {
    return this.notificationsService.deleteNotification(user, notificationId);
  }
}
