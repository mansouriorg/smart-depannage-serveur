import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { InterventionEventsModule } from '../intervention-events/intervention-events.module';

import { ArtisansController } from './artisans.controller';
import { ArtisansService } from './artisans.service';

@Module({
  imports: [
    PrismaModule,
    NotificationsModule,
    InterventionEventsModule,
  ],
  controllers: [ArtisansController],
  providers: [ArtisansService],
  exports: [ArtisansService],
})
export class ArtisansModule {}