import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';

import { InterventionWorkflowController } from './intervention-workflow.controller';
import { InterventionWorkflowService } from './intervention-workflow.service';

@Module({
  imports: [PrismaModule],
  controllers: [InterventionWorkflowController],
  providers: [InterventionWorkflowService],
  exports: [InterventionWorkflowService],
})
export class InterventionWorkflowModule {}