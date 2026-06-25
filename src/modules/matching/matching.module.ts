import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { RealtimeModule } from '../realtime/realtime.module';

import { MatchingController } from './matching.controller';
import { MatchingService } from './matching.service';

@Module({
  imports: [
    PrismaModule,
    RealtimeModule,
  ],
  controllers: [MatchingController],
  providers: [MatchingService],
  exports: [MatchingService],
})
export class MatchingModule {}