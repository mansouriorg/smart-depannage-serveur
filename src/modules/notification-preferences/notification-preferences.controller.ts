import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { NotificationPreferencesService } from './notification-preferences.service';
import { UpdateNotificationPreferencesDto } from './dto/update-notification-preferences.dto';

@Controller('notification-preferences')
@UseGuards(JwtAuthGuard)
export class NotificationPreferencesController {
  constructor(private readonly service: NotificationPreferencesService) {}

  @Get('me')
  getMine(@CurrentUser('id') userId: number) {
    return this.service.getMine(userId);
  }

  @Patch('me')
  updateMine(
    @CurrentUser('id') userId: number,
    @Body() dto: UpdateNotificationPreferencesDto,
  ) {
    return this.service.updateMine(userId, dto);
  }
}