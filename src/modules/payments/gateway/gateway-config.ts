/**
 * The configuration of the payment gateway (P2-10). Nothing here is required: without a provider, a card payment cannot be made and
 * the page says so (as before this step).
 *
 *   PAYMENT_PROVIDER            none (default) | konnect
 *   KONNECT_API_KEY             the key of the Konnect account (sent as `x-api-key`)
 *   KONNECT_WALLET_ID           the wallet that receives the money
 *   KONNECT_API_URL             the address of the API (default: production, https://api.konnect.network/api/v2; the sandbox has its own)
 *   API_PUBLIC_URL              the address at which the provider can reach THIS server (no path), e.g. https://api.example.tn:
 *                               the webhook is built from it. Required with a provider.
 *   PAYMENT_LIFESPAN_MINUTES    how long a customer has to pay by card (default 30, from 5 to 180)
 *   PAYMENT_EXPIRY_WORKER       off | false | 0: this process does not close the card payments that were not paid in time and does not
 *                               look for the ones whose webhook never came (default on; one process is enough, two do no harm)
 *   PAYMENT_EXPIRY_GRACE_MINUTES  how long after its time a card payment is asked about one last time before it is cancelled (default 5)
 */

export type PaymentProviderName = 'none' | 'konnect';

export type GatewayConfig = {
  provider: PaymentProviderName;
  konnect: { apiUrl: string; apiKey: string; walletId: string };
  /** Without a trailing slash; '' when not set. */
  publicUrl: string;
  lifespanMinutes: number;
  expiry: { workerEnabled: boolean; graceMinutes: number };
};

type Env = Record<string, unknown>;

export const DEFAULT_KONNECT_API_URL = 'https://api.konnect.network/api/v2';
export const DEFAULT_LIFESPAN_MINUTES = 30;
/** The longest a payment page stays open. The customer's tab remembers which request is being paid for three hours (see the shared package). */
export const MAX_LIFESPAN_MINUTES = 180;
export const DEFAULT_GRACE_MINUTES = 5;
export const MAX_GRACE_MINUTES = 120;

function text(env: Env, name: string): string {
  const value = env[name];

  return typeof value === 'string' ? value.trim() : '';
}

function integer(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = text(env, name);

  if (!raw) return fallback;

  const value = Number(raw);

  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

/**
 * An address as it is used: the form the URL parser makes of it (`https:/host` is read as `https://host/`), without the slashes at its end.
 * What cannot be read is returned as it was written (the validation of the settings says so).
 */
export function normalizedAddress(raw: string): string {
  try {
    const parsed = new URL(raw);

    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
  } catch {
    return raw.replace(/\/+$/, '');
  }
}

function isProduction(env: Env): boolean {
  return text(env, 'NODE_ENV').toLowerCase() === 'production';
}

export function readGatewayConfig(env: Env = process.env): GatewayConfig {
  const provider = text(env, 'PAYMENT_PROVIDER').toLowerCase();

  return {
    provider: provider === 'konnect' ? 'konnect' : 'none',
    konnect: {
      apiUrl: normalizedAddress(text(env, 'KONNECT_API_URL') || DEFAULT_KONNECT_API_URL),
      apiKey: text(env, 'KONNECT_API_KEY'),
      walletId: text(env, 'KONNECT_WALLET_ID'),
    },
    publicUrl: normalizedAddress(text(env, 'API_PUBLIC_URL')),
    lifespanMinutes: integer(env, 'PAYMENT_LIFESPAN_MINUTES', DEFAULT_LIFESPAN_MINUTES, 5, MAX_LIFESPAN_MINUTES),
    expiry: {
      workerEnabled: !['off', 'false', '0', 'no'].includes(text(env, 'PAYMENT_EXPIRY_WORKER').toLowerCase()) && text(env, 'NODE_ENV').toLowerCase() !== 'test',
      graceMinutes: integer(env, 'PAYMENT_EXPIRY_GRACE_MINUTES', DEFAULT_GRACE_MINUTES, 0, MAX_GRACE_MINUTES),
    },
  };
}

/** True when a provider is set up: a card payment can be made. */
export function gatewayConnected(config: GatewayConfig): boolean {
  return config.provider !== 'none';
}

/** Mistakes in the payment variables, for validateEnv(). Unset variables are fine; a provider with half its settings is not. */
export function gatewayConfigProblems(env: Env): string[] {
  const problems: string[] = [];
  const provider = text(env, 'PAYMENT_PROVIDER').toLowerCase();

  if (provider && !['none', 'konnect'].includes(provider)) {
    problems.push('PAYMENT_PROVIDER must be "none" or "konnect" (or empty).');
  }

  for (const name of ['PAYMENT_LIFESPAN_MINUTES', 'PAYMENT_EXPIRY_GRACE_MINUTES']) {
    const raw = text(env, name);

    if (raw && !/^\d+$/.test(raw)) problems.push(`${name} must be a whole number of minutes.`);
  }

  const lifespan = text(env, 'PAYMENT_LIFESPAN_MINUTES');

  if (/^\d+$/.test(lifespan) && (Number(lifespan) < 5 || Number(lifespan) > MAX_LIFESPAN_MINUTES)) {
    problems.push(`PAYMENT_LIFESPAN_MINUTES must be between 5 and ${MAX_LIFESPAN_MINUTES}.`);
  }

  const grace = text(env, 'PAYMENT_EXPIRY_GRACE_MINUTES');

  if (/^\d+$/.test(grace) && Number(grace) > MAX_GRACE_MINUTES) {
    problems.push(`PAYMENT_EXPIRY_GRACE_MINUTES must be between 0 and ${MAX_GRACE_MINUTES}.`);
  }

  if (provider !== 'konnect') return problems;

  for (const name of ['KONNECT_API_KEY', 'KONNECT_WALLET_ID']) {
    if (!text(env, name)) problems.push(`${name} is required when PAYMENT_PROVIDER=konnect.`);
  }

  for (const [name, required] of [
    ['KONNECT_API_URL', false],
    ['API_PUBLIC_URL', true],
  ] as const) {
    const value = text(env, name);

    if (!value) {
      if (required) problems.push(`${name} is required when PAYMENT_PROVIDER=konnect (the provider calls the webhook at this address).`);

      continue;
    }

    try {
      const parsed = new URL(value);

      // `https:/host` is read by the parser as `https://host`, but it is not what was meant to be written.
      if (!/^https?:\/\/[^/\s]/i.test(value)) problems.push(`${name} must start with https:// followed by the host.`);

      if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && !isProduction(env))) {
        problems.push(`${name} must start with https:// (http:// is only accepted outside production).`);
      }

      // Paths are added to both addresses: a query or a fragment would end up in the middle of them.
      if (parsed.search || parsed.hash || /[?#]/.test(value)) problems.push(`${name} must not carry a query or a fragment.`);

      // The address of the server, as the provider reaches it: the webhook path is added to it. The common mistake is to give the
      // address of the API with its /api (the webhook then asks for /api/api/... and is never received).
      if (name === 'API_PUBLIC_URL') {
        if (parsed.username || parsed.password) problems.push(`${name} must not carry a user name or a password.`);
        if (/\/api\/*$/i.test(parsed.pathname)) problems.push(`${name} is the address of the server without its /api (the path of the webhook is added to it).`);
      }
    } catch {
      problems.push(`${name} is not a valid URL.`);
    }
  }

  return problems;
}
