import { Module } from '@nestjs/common';

import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

/** The audit log (P3-02). `AuditInterceptor` is registered for the whole server in AppModule, next to the other global interceptors. */
@Module({
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
