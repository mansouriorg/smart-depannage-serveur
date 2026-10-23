import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { InterventionEventsModule } from '../intervention-events/intervention-events.module';
import { UsersModule } from '../users/users.module';
import { AssignmentModule } from '../assignment/assignment.module';
import { RealtimeModule } from '../realtime/realtime.module';

import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { LocaleService } from '../../common/locale/locale.service';

@Module({
  imports: [
    PrismaModule,
    NotificationsModule,
    InterventionEventsModule,
    // ContactChangeService: staff corrections of an e-mail or a phone.
    UsersModule,
    // The one path that gives a job to an artisan (P1-05).
    AssignmentModule,
    // The live event after a status change by the back office (P1-13).
    RealtimeModule,
  ],
  controllers: [AdminController],
  providers: [AdminService, LocaleService],
  exports: [AdminService, LocaleService],
})
export class AdminModule {}
