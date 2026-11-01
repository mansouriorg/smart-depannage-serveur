import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { MatchingModule } from '../matching/matching.module';
import { RealtimeModule } from '../realtime/realtime.module';

import { MissionOffersController } from './mission-offers.controller';
import { MissionOffersService } from './mission-offers.service';

/**
 * A job offered to several technicians at once (P3-07). The helpers the other modules call inside their own transactions (`offers-tx.ts`) need no
 * module; this one holds what talks to the matching, the notifications and the clock. The notifications module is global, so it is not listed.
 */
@Module({
  imports: [PrismaModule, MatchingModule, RealtimeModule],
  controllers: [MissionOffersController],
  providers: [MissionOffersService],
  exports: [MissionOffersService],
})
export class MissionOffersModule {}
