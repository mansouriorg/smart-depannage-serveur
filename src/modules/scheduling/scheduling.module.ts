import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { PrismaModule } from '../../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { AssignmentModule } from '../assignment/assignment.module';
import { MissionActionsModule } from '../mission-actions/mission-actions.module';

import { SchedulingController } from './scheduling.controller';
import { SchedulingService } from './scheduling.service';

@Module({
  imports: [
    PrismaModule,
    ScheduleModule.forRoot(),
    NotificationsModule,
    RealtimeModule,
    AssignmentModule,
    MissionActionsModule, // what an artisan does with a mission (P1-06)
  ],
  controllers: [SchedulingController],
  providers: [SchedulingService],
  exports: [SchedulingService],
})
export class SchedulingModule {}
