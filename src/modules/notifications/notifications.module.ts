import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { getJwtAccessSecret } from '../../config/env';

import { NotificationsController } from './notifications.controller';
import { NotificationsGateway } from './notifications.gateway';
import { NotificationsService } from './notifications.service';

@Global() // ⚠️ Global: This makes it usable everywhere without importing it repeatedly
@Module({
  imports: [
    // The socket gateway checks the access token of each connection.
    // registerAsync: the secret is read after .env has been loaded.
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: getJwtAccessSecret(),
      }),
    }),
  ],
  // Both were missing: without the controller there was no /notifications API
  // at all, and without the gateway no notification ever reached a socket.
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsGateway],
  exports: [NotificationsService],
})
export class NotificationsModule {}
