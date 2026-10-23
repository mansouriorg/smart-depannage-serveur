import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { InterventionEventsModule } from '../intervention-events/intervention-events.module';
import { CashLedgerController } from './cash-ledger.controller';
import { CashLedgerService } from './cash-ledger.service';

@Module({
  imports: [PrismaModule, InterventionEventsModule],
  controllers: [CashLedgerController],
  providers: [CashLedgerService],
  exports: [CashLedgerService],
})
export class CashLedgerModule {}
