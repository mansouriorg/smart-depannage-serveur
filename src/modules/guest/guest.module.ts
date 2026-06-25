import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { InterventionEventsModule } from '../intervention-events/intervention-events.module';

import { GuestController } from './guest.controller';
import { GuestService } from './guest.service';

@Module({
  imports: [
    PrismaModule,
    NotificationsModule,
    InterventionEventsModule,
  ],
  controllers: [GuestController],
  providers: [GuestService],
  exports: [GuestService],
})
export class GuestModule {}