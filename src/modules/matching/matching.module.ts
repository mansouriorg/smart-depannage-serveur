import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { AssignmentModule } from '../assignment/assignment.module';

import { MatchingController } from './matching.controller';
import { MatchingService } from './matching.service';

@Module({
  imports: [
    PrismaModule,
    AssignmentModule,
  ],
  controllers: [MatchingController],
  providers: [MatchingService],
  exports: [MatchingService],
})
export class MatchingModule {}
