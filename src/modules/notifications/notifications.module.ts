import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { getJwtAccessSecret } from '../../config/env';
import { readDeliveryConfig } from '../../config/delivery';

import { NotificationsController } from './notifications.controller';
import { NotificationsGateway } from './notifications.gateway';
import { NotificationsService } from './notifications.service';
import {
  createDeliveryProviders,
  DELIVERY_CONFIG,
  DeliveryProviders,
} from './delivery/delivery-providers';
import { MessageTemplatesService } from './delivery/message-templates.service';
import { OutboxService } from './delivery/outbox.service';

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
  providers: [
    NotificationsService,
    NotificationsGateway,
    OutboxService,
    MessageTemplatesService,
    // E-mail, SMS and push providers, chosen by the SMS_PROVIDER / SMTP_* / PUSH_PROVIDER variables.
    { provide: DELIVERY_CONFIG, useFactory: () => readDeliveryConfig(process.env) },
    {
      provide: DeliveryProviders,
      useFactory: (config: ReturnType<typeof readDeliveryConfig>) => createDeliveryProviders(config),
      inject: [DELIVERY_CONFIG],
    },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
