import { Body, Controller, Get, Header, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';

import { PaymentsService } from './payments.service';
import { RateLimit, RateLimitGuard } from '../../common/rate-limit/rate-limit.guard';

/**
 * Where the payment provider tells us that something happened to a payment (P2-10).
 *
 *   GET  /api/payments/webhooks/konnect?payment_ref=...     (Konnect calls it this way)
 *   POST /api/payments/webhooks/konnect                     (the same, with the number in the body, for a provider that posts)
 *
 * Public: the provider has no account. The call proves nothing and changes nothing by itself: it names a payment, and the server asks
 * the provider what became of it (`PaymentsService.handleProviderNotification`). So a forged call can at most make the server ask: once
 * every few seconds for a payment, and what the customer holds (the number is in the address of the payment page) is not worth more.
 * A payment we know and one we do not are answered alike, except when the provider could not be asked for a known one (503: the
 * provider tries again); the number of a payment is long and random, so the difference cannot be used to find one. The limit is per
 * address and wide (the provider calls from a few addresses). Behind a proxy it is the address of the proxy unless TRUST_PROXY is set.
 *
 * This controller is listed before `PaymentsController` in the module: `/payments/webhooks/...` must not be read as `/payments/:paymentId/...`.
 */
@Controller('payments/webhooks')
export class PaymentWebhooksController {
  constructor(private readonly service: PaymentsService) {}

  @UseGuards(RateLimitGuard)
  @RateLimit({ name: 'payment-webhook', limit: 600, windowMs: 60_000 })
  @Header('Cache-Control', 'no-store')
  @Get(':provider')
  receiveGet(@Param('provider') provider: string, @Query() query: Record<string, unknown>) {
    return this.service.handleProviderNotification(provider, { query: query ?? {}, body: undefined });
  }

  @UseGuards(RateLimitGuard)
  @RateLimit({ name: 'payment-webhook', limit: 600, windowMs: 60_000 })
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @Post(':provider')
  receivePost(@Param('provider') provider: string, @Query() query: Record<string, unknown>, @Body() body: unknown) {
    return this.service.handleProviderNotification(provider, { query: query ?? {}, body });
  }
}
