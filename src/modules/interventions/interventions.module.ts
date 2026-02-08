import { Module } from '@nestjs/common';
import { InterventionsService } from './interventions.service';
import { InterventionsController } from './interventions.controller';
import { InterventionsGateway } from './interventions.gateway';

@Module({
  controllers: [InterventionsController],
  providers: [InterventionsService, InterventionsGateway],
})
export class InterventionsModule {}
