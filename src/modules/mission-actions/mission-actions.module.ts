import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { InterventionEventsModule } from '../intervention-events/intervention-events.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { MissionActionsService } from './mission-actions.service';

/**
 * What an artisan does with a mission (P1-06): accept, give back, on the way, arrived.
 * The notifications module is global, so it is not listed.
 */
@Module({
  imports: [PrismaModule, InterventionEventsModule, RealtimeModule],
  providers: [MissionActionsService],
  exports: [MissionActionsService],
})
export class MissionActionsModule {}
