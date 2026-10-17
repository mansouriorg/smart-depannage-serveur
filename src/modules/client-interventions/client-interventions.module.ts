import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { ClientInterventionsController } from './client-interventions.controller';
import { ClientInterventionsService } from './client-interventions.service';
import { InterventionEventsModule } from '../intervention-events/intervention-events.module';
import { InterventionsModule } from '../interventions/interventions.module';

@Module({
  imports: [PrismaModule, InterventionEventsModule, InterventionsModule],
  controllers: [ClientInterventionsController],
  providers: [ClientInterventionsService],
  exports: [ClientInterventionsService],
})
export class ClientInterventionsModule {}
