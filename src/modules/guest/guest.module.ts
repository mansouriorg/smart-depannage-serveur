import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { InterventionEventsModule } from '../intervention-events/intervention-events.module';
import { InterventionsModule } from '../interventions/interventions.module';
import { FilesModule } from '../files/files.module';
import { ComplaintsModule } from '../complaints/complaints.module';
import { BotCheckModule } from '../../common/bot-check/bot-check.module';
import { PaymentsModule } from '../payments/payments.module';

import { GuestController } from './guest.controller';
import { GuestService } from './guest.service';

@Module({
  imports: [
    PrismaModule,
    NotificationsModule,
    InterventionEventsModule,
    // StaffAlertsService: the live event, the notifications and the alert text for a new request.
    InterventionsModule,
    // The picture store, and the complaint a reported problem opens.
    FilesModule,
    ComplaintsModule,
    // The check of the public request form (P1-16).
    BotCheckModule,
    // The payment provider, and the check of a card payment (P2-10).
    PaymentsModule,
  ],
  controllers: [GuestController],
  providers: [GuestService],
  exports: [GuestService],
})
export class GuestModule {}
