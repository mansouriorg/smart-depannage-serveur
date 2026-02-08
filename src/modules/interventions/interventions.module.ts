import { Module } from '@nestjs/common';
import { InterventionsService } from './interventions.service';
import { InterventionsController } from './interventions.controller';
import { InterventionsGateway } from './interventions.gateway';
import { NotificationsModule } from '../notifications/notifications.module'; // 1. Import the module

@Module({
  imports: [
    NotificationsModule, // 2. Add it here so the Service can use it
  ],
  controllers: [InterventionsController],
  providers: [
    InterventionsService, 
    InterventionsGateway
  ],
  exports: [InterventionsService], 
})
export class InterventionsModule {}