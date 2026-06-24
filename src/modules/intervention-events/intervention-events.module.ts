import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { InterventionEventsService } from './intervention-events.service';

@Module({
  imports: [PrismaModule],
  providers: [InterventionEventsService],
  exports: [InterventionEventsService],
})
export class InterventionEventsModule {}