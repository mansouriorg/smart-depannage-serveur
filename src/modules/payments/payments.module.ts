import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { InterventionEventsModule } from '../intervention-events/intervention-events.module';
import { GATEWAY_CONFIG, PaymentGatewayService } from './gateway/payment-gateway.service';
import { readGatewayConfig } from './gateway/gateway-config';
import { PaymentExpiryService } from './payment-expiry.service';
import { PaymentWebhooksController } from './payment-webhooks.controller';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

@Module({
  imports: [PrismaModule, InterventionEventsModule],
  // The webhooks first: `/payments/webhooks/...` must not be read as `/payments/:paymentId/...`.
  controllers: [PaymentWebhooksController, PaymentsController],
  providers: [
    // Read when the application starts, so that `.env` is already loaded.
    { provide: GATEWAY_CONFIG, useFactory: () => readGatewayConfig(process.env) },
    PaymentGatewayService,
    PaymentsService,
    PaymentExpiryService,
  ],
  exports: [PaymentsService, PaymentGatewayService],
})
export class PaymentsModule {}
