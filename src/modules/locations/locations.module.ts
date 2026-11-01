import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';

import { LocationHistoryPurgeService } from './history-purge.service';

/** The history of the technicians' positions (P3-05): what writes a position is `ping-plan.ts`, what ends it is this module's daily purge. */
@Module({
  imports: [PrismaModule],
  providers: [LocationHistoryPurgeService],
})
export class LocationsModule {}
