/**
 * Holds the gateway the server was set up with (P2-10) and answers the questions the payment code asks about it. One object so that the
 * payments, the tracking link and the timer share it, and a spec can hand them a fake one.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';

import { gatewayConnected, readGatewayConfig } from './gateway-config';
import type { GatewayConfig } from './gateway-config';
import { KonnectAdapter } from './konnect.adapter';
import { GatewayError } from './payment-gateway';
import type { GatewayCreateInput, GatewayCreated, GatewayNotificationRequest, GatewayStatus, PaymentGateway } from './payment-gateway';
import { FetchLike } from '../../notifications/delivery/providers/http';

/** Injection tokens (the configuration is read when the application starts, so that `.env` is already loaded). */
export const GATEWAY_CONFIG = 'GATEWAY_CONFIG';
/** Not provided by the module: a spec (or a future provider) can provide a ready gateway under this name. */
export const GATEWAY_ADAPTER = 'GATEWAY_ADAPTER';

export function createGateway(config: GatewayConfig, fetchFn?: FetchLike): PaymentGateway | null {
  if (config.provider === 'konnect') return new KonnectAdapter(config.konnect, fetchFn);

  return null;
}

/** The path the provider calls: `/api` is the prefix of the server, `payments/webhooks/{name}` the route (see `payment-webhooks.controller.ts`). */
export const WEBHOOK_PATH = '/api/payments/webhooks';

@Injectable()
export class PaymentGatewayService {
  readonly config: GatewayConfig;
  private readonly gateway: PaymentGateway | null;

  constructor(
    @Optional() @Inject(GATEWAY_CONFIG) config?: GatewayConfig,
    @Optional() @Inject(GATEWAY_ADAPTER) gateway?: PaymentGateway | null,
  ) {
    this.config = config ?? readGatewayConfig(process.env);
    this.gateway = gateway === undefined ? createGateway(this.config) : gateway;
  }

  /** A card payment can be made: a provider is set up. */
  connected(): boolean {
    return this.gateway !== null && gatewayConnected(this.config);
  }

  /** The provider's name in `PaymentProvider`, or null when none is set up. */
  provider(): PaymentGateway['provider'] | null {
    return this.gateway ? this.gateway.provider : null;
  }

  /** The name the provider has in the address of the webhook (`konnect`). */
  routeName(): string | null {
    return this.gateway ? this.gateway.provider.toLowerCase() : null;
  }

  /** Where the provider tells us about a payment. */
  webhookUrl(): string {
    return `${this.config.publicUrl}${WEBHOOK_PATH}/${this.routeName() ?? ''}`;
  }

  private required(): PaymentGateway {
    if (!this.gateway) throw new GatewayError('No payment provider is set up.', false, 'NOT_SET_UP');

    return this.gateway;
  }

  create(input: GatewayCreateInput): Promise<GatewayCreated> {
    return this.required().create(input);
  }

  status(providerPaymentId: string): Promise<GatewayStatus> {
    return this.required().status(providerPaymentId);
  }

  readNotification(request: GatewayNotificationRequest): string | null {
    return this.gateway ? this.gateway.readNotification(request) : null;
  }
}
