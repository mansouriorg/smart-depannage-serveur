import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { PrismaModule } from '../../prisma/prisma.module';

import { getJwtAccessSecret } from '../../config/env';

import { RealtimeGateway } from './realtime.gateway';
import { RealtimeService } from './realtime.service';

@Module({
  imports: [
    PrismaModule,
    // registerAsync: the factory runs after ConfigModule has loaded .env.
    // A plain register() would read process.env while the file is imported,
    // i.e. before .env is loaded, and silently use the wrong secret.
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: getJwtAccessSecret(),
      }),
    }),
  ],
  providers: [
    RealtimeGateway,
    RealtimeService,
  ],
  exports: [
    RealtimeService,
    RealtimeGateway,
  ],
})
export class RealtimeModule {}
