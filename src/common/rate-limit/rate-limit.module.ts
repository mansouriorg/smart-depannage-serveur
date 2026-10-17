import { Global, Module } from '@nestjs/common';

import { RateLimitGuard } from './rate-limit.guard';
import { RateLimitService } from './rate-limit.service';

/**
 * Global so every module can inject RateLimitService and use RateLimitGuard
 * without importing this module. One shared instance means one shared set of
 * counters.
 */
@Global()
@Module({
  providers: [RateLimitService, RateLimitGuard],
  exports: [RateLimitService, RateLimitGuard],
})
export class RateLimitModule {}
