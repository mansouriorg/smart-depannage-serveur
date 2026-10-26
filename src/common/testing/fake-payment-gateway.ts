import {
  GatewayCreateInput,
  GatewayCreated,
  GatewayError,
  GatewayNotificationRequest,
  GatewayState,
  GatewayStatus,
  PaymentGateway,
} from '../../modules/payments/gateway/payment-gateway';

/**
 * A payment provider for the specs (P2-10): it keeps the payments it was asked for, answers what the spec made of them, and can be made
 * slow or broken. Nothing leaves the process. The levers are the fields and `settle`.
 */
export class FakePaymentGateway implements PaymentGateway {
  readonly provider = 'KONNECT' as const;
  readonly created: GatewayCreateInput[] = [];
  readonly kept = new Map<string, { state: GatewayState; amount: number | null; currency: string | null; orderId: string | null }>();

  /** How many times the provider was asked for the status of a payment. */
  statusCalls = 0;
  /** A provider that cannot be reached: `create` / `status` throw this. */
  createFails: GatewayError | null = null;
  statusFails: GatewayError | null = null;
  /** A provider that is slow to create: `create` waits for this promise. */
  hold: Promise<void> | null = null;

  private counter = 0;

  async create(input: GatewayCreateInput): Promise<GatewayCreated> {
    if (this.hold) await this.hold;
    if (this.createFails) throw this.createFails;

    this.counter += 1;

    const providerPaymentId = `fake-ref-${this.counter}`;

    this.created.push(input);
    this.kept.set(providerPaymentId, { state: 'PENDING', amount: input.amount, currency: input.currency, orderId: input.orderId });

    return { providerPaymentId, payUrl: `https://pay.example.test/pay?payment_ref=${providerPaymentId}` };
  }

  async status(providerPaymentId: string): Promise<GatewayStatus> {
    this.statusCalls += 1;

    if (this.statusFails) throw this.statusFails;

    const entry = this.kept.get(providerPaymentId);

    if (!entry) throw new GatewayError('The provider does not know this payment.', false);

    return { providerPaymentId, ...entry };
  }

  readNotification(request: GatewayNotificationRequest): string | null {
    const body = request.body && typeof request.body === 'object' ? (request.body as Record<string, unknown>) : {};
    const value = request.query?.payment_ref ?? body.payment_ref;

    return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(value) ? value : null;
  }

  /** The customer paid (or failed, or ran out of time) at the provider. The amount and the order are those asked for unless `with` says otherwise. */
  settle(providerPaymentId: string, state: GatewayState, withDetails: Partial<{ amount: number | null; currency: string | null; orderId: string | null }> = {}): void {
    const entry = this.kept.get(providerPaymentId);

    if (!entry) throw new Error(`no payment ${providerPaymentId}`);

    this.kept.set(providerPaymentId, { ...entry, ...withDetails, state });
  }

  /** The number the provider gave to the n-th payment (1 is the first). */
  ref(n = this.counter): string {
    return `fake-ref-${n}`;
  }
}
