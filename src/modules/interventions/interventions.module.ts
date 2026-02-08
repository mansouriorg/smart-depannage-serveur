import { Module } from '@nestjs/common';
import { InterventionsService } from './interventions.service';
import { InterventionsController } from './interventions.controller';
import { InterventionsGateway } from './interventions.gateway'; // Import this

@Module({
  controllers: [InterventionsController],
  providers: [
    InterventionsService, 
    InterventionsGateway // Add to providers
  ],
})
export class InterventionsModule {}