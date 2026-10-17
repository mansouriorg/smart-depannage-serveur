import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { InterventionEventsModule } from '../intervention-events/intervention-events.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { AssignmentService } from './assignment.service';

/**
 * The one path that gives a job to an artisan (P1-05). The notifications module is
 * global, so it is not listed.
 */
@Module({
  imports: [PrismaModule, InterventionEventsModule, RealtimeModule],
  providers: [AssignmentService],
  exports: [AssignmentService],
})
export class AssignmentModule {}
