import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { FilesModule } from '../files/files.module';
import { InterventionEventsModule } from '../intervention-events/intervention-events.module';
import { ProofsController } from './proofs.controller';
import { ProofsService } from './proofs.service';

/**
 * Proof of work (P1-07): the one way a before/after photo gets onto a job, and the review
 * queue of the back office. The notifications module is global, so it is not listed.
 */
@Module({
  imports: [PrismaModule, FilesModule, InterventionEventsModule],
  controllers: [ProofsController],
  providers: [ProofsService],
  exports: [ProofsService],
})
export class ProofsModule {}
