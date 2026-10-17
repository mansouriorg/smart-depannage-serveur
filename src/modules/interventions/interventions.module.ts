import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { getJwtAccessSecret } from '../../config/env';
import { InterventionsService } from './interventions.service';
import { InterventionsController } from './interventions.controller';
import { InterventionsGateway } from './interventions.gateway';
import { StaffAlertsService } from './staff-alerts.service';
import { NotificationsModule } from '../notifications/notifications.module'; // 1. Import the module
import { AssignmentModule } from '../assignment/assignment.module';

@Module({
  imports: [
    NotificationsModule, // 2. Add it here so the Service can use it
    AssignmentModule, // the one way an artisan is given a job (P1-05)
    // The gateway verifies the access token of every socket (P0-05).
    JwtModule.registerAsync({
      useFactory: () => ({ secret: getJwtAccessSecret() }),
    }),
  ],
  controllers: [InterventionsController],
  providers: [
    InterventionsService, 
    InterventionsGateway,
    StaffAlertsService,
  ],
  // StaffAlertsService is what every route that makes a request calls (P1-04),
  // including the ones that live in other modules (guest, client-interventions).
  exports: [InterventionsService, StaffAlertsService], 
})
export class InterventionsModule {}
