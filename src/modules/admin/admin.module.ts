import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { InterventionEventsModule } from '../intervention-events/intervention-events.module';
import { UsersModule } from '../users/users.module';
import { AssignmentModule } from '../assignment/assignment.module';

import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [
    PrismaModule,
    NotificationsModule,
    InterventionEventsModule,
    // ContactChangeService: staff corrections of an e-mail or a phone.
    UsersModule,
    // The one path that gives a job to an artisan (P1-05).
    AssignmentModule,
  ],
  controllers: [AdminController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
