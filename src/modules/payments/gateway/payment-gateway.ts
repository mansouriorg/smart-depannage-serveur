/**
 * The payment gateway (P2-10): what the server needs from a company that takes card payments for it, in one small interface.
 *
 * Three providers sell the same thing in Tunisia (Konnect, Flouci, Paymee). The server does not depend on any of them: it knows how to
 *  - `create` a payment (the provider answers with the page where the customer pays, and its own number for the payment),
 *  - ask for the `status` of a payment (the only thing that says whether money came: a webhook, a return page or a timer only say
 *    "go and look"),
 *  - read which payment a `notification` (a webhook) is about.
 * A provider is one file that fills this in (`konnect.adapter.ts`). Another one is a second file and a line in `payment-gateway.service.ts`.
 */

/** What the provider says about a payment, in our words. Anything the provider says that we do not know is `PENDING`: never a reason to fail or to confirm. */
export type GatewayState = 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED';

/**
 * The page of the provider where the customer is sent: an https address of a host (no user name, no space, no backslash), short enough
 * to be kept. The same rule is applied by the pages before they send the customer there (`isPayUrl` of the shared package).
 */
export function isPayPage(url: unknown): url is string {
  return typeof url === 'string' && url.length <= 2000 && /^https:\/\/[^\s/?#@\\]+(?:[/?#][^\s\\]*)?$/i.test(url);
}

/**
 * Whether the page is on a host of the provider: the host of its API, or a host of the same family (`gateway.konnect.network` for
 * `api.konnect.network`: the last two names of the host). The customer is sent to this address with our name on the button, so a
 * wrong address in the settings, or an answer that was tampered with, must not send them to another site. A host that is an address
 * (or has a single name, such as `localhost`) is only matched exactly.
 */
export function isOnProviderHost(url: string, apiUrl: string): boolean {
  let page: string;
  let api: string;

  try {
    page = new URL(url).hostname.toLowerCase();
    api = new URL(apiUrl).hostname.toLowerCase();
  } catch {
    return false;
  }

  if (page === api) return true;

  const names = api.split('.');

  if (names.length < 3 || /^[\d.]+$/.test(api) || api.includes(':')) return false;

  const family = names.slice(-2).join('.');

  return page === family || page.endsWith(`.${family}`);
}

export interface GatewayCreateInput {
  /** Our own name for the payment (`DEP-12-P34`): the provider echoes it, and it is checked when the payment is verified. */
  orderId: string;
  /** In dinars, exact to the millime. */
  amount: number;
  currency: string;
  description: string;
  /** How long the customer has to pay, from now. */
  lifespanMinutes: number;
  successUrl: string;
  failUrl: string;
  /** Where the provider tells us that something happened. */
  webhookUrl: string;
  /** Only the name: the provider needs no more to take a payment (no phone, no e-mail is sent). */
  customer?: { name?: string | null };
}

export interface GatewayCreated {
  /** The provider's number for the payment (it is what a notification names). */
  providerPaymentId: string;
  /** The page of the provider where the customer pays. */
  payUrl: string;
}

export interface GatewayStatus {
  providerPaymentId: string;
  state: GatewayState;
  /** In dinars; null when the provider did not say (a payment is then never confirmed from it). */
  amount: number | null;
  currency: string | null;
  /** Our name for the payment, as the provider kept it; null when the provider did not say. */
  orderId: string | null;
}

/** What a webhook request carries: the query of the address and the body, as the framework read them. */
export interface GatewayNotificationRequest {
  query: Record<string, unknown>;
  body: unknown;
}

/**
 * Why the provider could not be used, in a word that is safe to log (it says nothing of the address, the key or the body):
 * `NETWORK`/`TIMEOUT` (nothing came back), `REFUSED` (the key or the wallet was refused: the settings are to be looked at),
 * `UNKNOWN_PAYMENT` (the provider does not know the payment), `HTTP` (any other status), `BAD_ANSWER` (an answer that could not be
 * used), `NOT_SET_UP` (no provider).
 */
export type GatewayErrorCode = 'NETWORK' | 'TIMEOUT' | 'REFUSED' | 'UNKNOWN_PAYMENT' | 'HTTP' | 'BAD_ANSWER' | 'NOT_SET_UP';

/** The provider could not be asked, or refused. `retryable`: a network error, a time-out, a 5xx. Never carries the address, a key or a body. */
export class GatewayError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code: GatewayErrorCode = 'HTTP',
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

export interface PaymentGateway {
  /** The name of the provider in `PaymentProvider`. */
  readonly provider: 'KONNECT' | 'FLOUCI' | 'PAYMEE';
  create(input: GatewayCreateInput): Promise<GatewayCreated>;
  status(providerPaymentId: string): Promise<GatewayStatus>;
  /** The provider's number of the payment a notification is about, or null when it names none. */
  readNotification(request: GatewayNotificationRequest): string | null;
}
