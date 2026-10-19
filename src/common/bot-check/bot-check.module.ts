import { Module } from '@nestjs/common';

import { BotCheckGuard } from './bot-check.guard';
import { BotCheckService } from './bot-check.service';

@Module({
  providers: [BotCheckService, BotCheckGuard],
  exports: [BotCheckService, BotCheckGuard],
})
export class BotCheckModule {}
