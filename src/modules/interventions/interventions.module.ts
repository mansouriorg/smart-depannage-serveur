import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { getJwtAccessSecret } from '../../config/env';
import { InterventionsService } from './interventions.service';
import { InterventionsController } from './interventions.controller';
import { InterventionsGateway } from './interventions.gateway';
import { StaffAlertsService } from './staff-alerts.service';
import { NotificationsModule } from '../notifications/notifications.module'; // 1. Import the module
import { AssignmentModule } from '../assignment/assignment.module';
import { MissionActionsModule } from '../mission-actions/mission-actions.module';
import { ProofsModule } from '../proofs/proofs.module';
import { BotCheckModule } from '../../common/bot-check/bot-check.module';

@Module({
  imports: [
    NotificationsModule, // 2. Add it here so the Service can use it
    AssignmentModule, // the one way an artisan is given a job (P1-05)
    MissionActionsModule, // what an artisan does with a mission (P1-06)
    ProofsModule, // the one way a before/after photo gets onto a job (P1-07)
    BotCheckModule, // the check of the public request form, which this older route shares (P1-16)
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
