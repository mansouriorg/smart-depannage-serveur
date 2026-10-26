/**
 * Konnect (https://konnect.network), a Tunisian payment gateway (P2-10).
 *
 *   POST {api}/payments/init-payment   x-api-key        -> { payUrl, paymentRef }
 *   GET  {api}/payments/{paymentRef}   x-api-key        -> { payment: { status, amount, token, orderId, ... } }
 *   webhook: GET {webhook}?payment_ref={paymentRef}     (the call only says "look at this payment")
 *
 * Amounts are in millimes (an integer: 12.345 TND is 12345). The field names are those of Konnect's public SDKs; the status words
 * ("completed", "pending", ...) are read defensively: a word that is not known is "pending", never a reason to confirm or to fail a payment.
 * What this file could not check without an account (the exact status words, the amount field of the details) is listed on the page of
 * the step, and has to be tried once with the sandbox of Konnect before the card is switched on.
 *
 * Nothing here logs: an address, a key or a body can hold a secret.
 */
import { fromMillimes, toMillimes } from '../../../common/money/money';
import { FetchLike, defaultFetch } from '../../notifications/delivery/providers/http';
import { GatewayConfig } from './gateway-config';
import {
  GatewayCreateInput,
  GatewayCreated,
  GatewayError,
  GatewayNotificationRequest,
  GatewayState,
  GatewayStatus,
  PaymentGateway,
  isOnProviderHost,
  isPayPage,
} from './payment-gateway';

/** What the customer may pay with at Konnect: the card (and the e-DINAR card of La Poste). The wallet and the other ways are left out. */
export const KONNECT_METHODS = ['bank_card', 'e-DINAR'];

const TIMEOUT_MS = 10_000;

/**
 * The number of a payment, as Konnect writes it: letters, digits and a few signs, starting with a letter or a digit (`..` or `.` would
 * walk out of the path of the payment). Anything else is not a number of ours to look up.
 */
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;

/** The most Konnect can be believed to say, in millimes: what the amount column of a payment holds. */
const MAX_MILLIMES = 99_999_999_999_999;

export function konnectState(raw: unknown): GatewayState {
  const word = typeof raw === 'string' ? raw.trim().toLowerCase() : '';

  if (word === 'completed' || word === 'paid' || word === 'success' || word === 'succeeded') return 'PAID';
  if (word === 'expired') return 'EXPIRED';
  if (['failed', 'failure', 'declined', 'rejected', 'canceled', 'cancelled'].includes(word)) return 'FAILED';

  return 'PENDING';
}

/**
 * An amount in millimes: a whole number, or the digits of one (no sign, no exponent, no `0x`), within what an amount column holds.
 * Anything else is "not said": a payment is never confirmed from it (it goes to the team).
 */
function millimesOf(value: unknown): number | null {
  const number = typeof value === 'string' && /^\d{1,15}$/.test(value.trim()) ? Number(value.trim()) : value;

  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0 || number > MAX_MILLIMES) return null;

  return fromMillimes(number);
}

function parse(body: string): any {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

export class KonnectAdapter implements PaymentGateway {
  readonly provider = 'KONNECT' as const;

  constructor(
    private readonly config: GatewayConfig['konnect'],
    private readonly fetchFn: FetchLike = defaultFetch(),
  ) {}

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const AbortControllerClass = (globalThis as any).AbortController;
    const controller = AbortControllerClass ? new AbortControllerClass() : undefined;
    const timer: any = setTimeout(() => controller?.abort(), TIMEOUT_MS);

    try {
      const response = await this.fetchFn(`${this.config.apiUrl}${path}`, {
        method,
        headers: { 'x-api-key': this.config.apiKey, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller?.signal,
        // A redirect would carry the key to another address.
        redirect: 'error',
      });
      const text = await response.text();

      return { status: response.status, json: parse(text) };
    } catch (error: any) {
      // Never put the address or the message in the error: they can carry the key.
      const timedOut = error?.name === 'AbortError';

      throw new GatewayError(`Konnect: network error (${timedOut ? 'timeout' : (error?.code ?? 'failed')})`, true, timedOut ? 'TIMEOUT' : 'NETWORK');
    } finally {
      clearTimeout(timer);
    }
  }

  private refuse(status: number): never {
    if (status === 401 || status === 403) throw new GatewayError('Konnect refused the key (check KONNECT_API_KEY and the wallet).', false, 'REFUSED');
    if (status === 404) throw new GatewayError('Konnect does not know this payment.', false, 'UNKNOWN_PAYMENT');

    throw new GatewayError(`Konnect answered ${status}.`, status >= 500 || status === 429 || status === 408, 'HTTP');
  }

  async create(input: GatewayCreateInput): Promise<GatewayCreated> {
    const name = (input.customer?.name ?? '').trim();
    const [firstName, ...rest] = name.split(/\s+/).filter(Boolean);
    const { status, json } = await this.call('POST', '/payments/init-payment', {
      receiverWalletId: this.config.walletId,
      token: input.currency,
      amount: toMillimes(input.amount),
      type: 'immediate',
      description: input.description.slice(0, 200),
      acceptedPaymentMethods: KONNECT_METHODS,
      lifespan: input.lifespanMinutes,
      checkoutForm: false,
      addPaymentFeesToAmount: false,
      ...(firstName ? { firstName } : {}),
      ...(rest.length > 0 ? { lastName: rest.join(' ') } : {}),
      orderId: input.orderId,
      webhook: input.webhookUrl,
      silentWebhook: true,
      successUrl: input.successUrl,
      failUrl: input.failUrl,
    });

    if (status < 200 || status >= 300) this.refuse(status);

    const payUrl = typeof json?.payUrl === 'string' ? json.payUrl : '';
    const ref = typeof json?.paymentRef === 'string' ? json.paymentRef : '';

    if (!REF_PATTERN.test(ref)) throw new GatewayError('Konnect answered without a payment number.', false, 'BAD_ANSWER');

    // The customer is sent to this address: nothing but a web address on a host of the provider is accepted.
    if (!isPayPage(payUrl) || !isOnProviderHost(payUrl, this.config.apiUrl)) throw new GatewayError('Konnect answered without a payment page.', false, 'BAD_ANSWER');

    return { providerPaymentId: ref, payUrl };
  }

  async status(providerPaymentId: string): Promise<GatewayStatus> {
    if (!REF_PATTERN.test(providerPaymentId)) throw new GatewayError('Not a payment number.', false, 'BAD_ANSWER');

    const { status, json } = await this.call('GET', `/payments/${encodeURIComponent(providerPaymentId)}`);

    if (status < 200 || status >= 300) this.refuse(status);

    const payment = json?.payment ?? json;

    if (!payment || typeof payment !== 'object') throw new GatewayError('Konnect answered without the payment.', true, 'BAD_ANSWER');

    const token = typeof payment.token === 'string' ? payment.token.trim().toUpperCase() : null;

    return {
      providerPaymentId,
      state: konnectState(payment.status),
      amount: millimesOf(payment.amount),
      currency: token && token !== '' ? token : null,
      orderId: typeof payment.orderId === 'string' && payment.orderId !== '' ? payment.orderId : null,
    };
  }

  readNotification(request: GatewayNotificationRequest): string | null {
    const body = request.body && typeof request.body === 'object' ? (request.body as Record<string, unknown>) : {};

    for (const value of [request.query?.payment_ref, request.query?.paymentRef, body.payment_ref, body.paymentRef]) {
      if (typeof value === 'string' && REF_PATTERN.test(value)) return value;
    }

    return null;
  }
}
