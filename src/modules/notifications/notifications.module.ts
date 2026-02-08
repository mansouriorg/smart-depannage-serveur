import { Global, Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';

@Global() // ⚠️ Global: This makes it usable everywhere without importing it repeatedly
@Module({
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}