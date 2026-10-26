import { validateEnv } from '../../../config/env';
import { DEFAULT_KONNECT_API_URL, MAX_LIFESPAN_MINUTES, gatewayConfigProblems, gatewayConnected, normalizedAddress, readGatewayConfig } from './gateway-config';
import { KonnectAdapter, konnectState } from './konnect.adapter';
import { GatewayError, isOnProviderHost, isPayPage } from './payment-gateway';
import { PaymentGatewayService } from './payment-gateway.service';
import { onlineProviderConnected } from '../payment-options';

/**
 * The payment gateway (P2-10): its configuration, its checks at start-up, and the Konnect adapter, on a fake `fetch` (nothing leaves the process).
 */
const ENV = { PAYMENT_PROVIDER: 'konnect', KONNECT_API_KEY: 'key-secret-123', KONNECT_WALLET_ID: 'wallet-1', API_PUBLIC_URL: 'https://api.example.test' };
const API = 'https://konnect.example.test/api/v2';

type Call = { url: string; init: any };

function fakeFetch(answers: Array<{ status?: number; body?: unknown; raw?: string; throws?: any }>) {
  const calls: Call[] = [];
  const fetchFn = async (url: string, init?: any) => {
    calls.push({ url, init });

    const answer = answers.shift() ?? { status: 500, body: {} };

    if (answer.throws) throw answer.throws;

    const status = answer.status ?? 200;

    return { ok: status >= 200 && status < 300, status, text: async () => answer.raw ?? JSON.stringify(answer.body ?? {}) };
  };

  return { fetchFn, calls };
}

const adapter = (answers: Array<any>) => {
  const f = fakeFetch(answers);

  return { adapter: new KonnectAdapter({ apiUrl: API, apiKey: 'key-secret-123', walletId: 'wallet-1' }, f.fetchFn as any), calls: f.calls };
};

async function refusal(work: () => Promise<unknown>): Promise<any> {
  try {
    await work();
  } catch (error) {
    return error;
  }

  return null;
}

const INPUT = {
  orderId: 'DEP-12-P34',
  amount: 12.345,
  currency: 'TND',
  description: 'Dépannage n° 12',
  lifespanMinutes: 30,
  successUrl: 'https://site.example.test/paiement/retour',
  failUrl: 'https://site.example.test/paiement/retour',
  webhookUrl: 'https://api.example.test/api/payments/webhooks/konnect',
  customer: { name: 'Sami Ben Ali' },
};

describe('the configuration of the payment gateway (P2-10)', () => {
  it('nothing set: no provider, a card payment cannot be made', () => {
    const config = readGatewayConfig({});

    expect(config.provider).toBe('none');
    expect(gatewayConnected(config)).toBe(false);
    expect(onlineProviderConnected({})).toBe(false);
    expect(config.lifespanMinutes).toBe(30);
    expect(config.konnect.apiUrl).toBe(DEFAULT_KONNECT_API_URL);
    expect(config.expiry.graceMinutes).toBe(5);
  });

  it('konnect: the key, the wallet, the public address and the clocks are read', () => {
    const config = readGatewayConfig({ ...ENV, KONNECT_API_URL: 'https://sandbox.example.test/api/v2/', PAYMENT_LIFESPAN_MINUTES: '45', PAYMENT_EXPIRY_GRACE_MINUTES: '2', API_PUBLIC_URL: 'https://api.example.test/' });

    expect(config.provider).toBe('konnect');
    expect(onlineProviderConnected(ENV)).toBe(true);
    expect(config.konnect).toEqual({ apiUrl: 'https://sandbox.example.test/api/v2', apiKey: 'key-secret-123', walletId: 'wallet-1' });
    expect(config.publicUrl).toBe('https://api.example.test');
    expect(config.lifespanMinutes).toBe(45);
    expect(config.expiry.graceMinutes).toBe(2);
  });

  it('a value out of range falls back to the default', () => {
    expect(readGatewayConfig({ PAYMENT_LIFESPAN_MINUTES: '2' }).lifespanMinutes).toBe(30);
    expect(readGatewayConfig({ PAYMENT_LIFESPAN_MINUTES: '5000' }).lifespanMinutes).toBe(30);
    expect(readGatewayConfig({ PAYMENT_LIFESPAN_MINUTES: '181' }).lifespanMinutes).toBe(30);
    expect(readGatewayConfig({ PAYMENT_LIFESPAN_MINUTES: '180' }).lifespanMinutes).toBe(180);
    expect(readGatewayConfig({ PAYMENT_LIFESPAN_MINUTES: '5' }).lifespanMinutes).toBe(5);
    expect(readGatewayConfig({ PAYMENT_LIFESPAN_MINUTES: 'abc' }).lifespanMinutes).toBe(30);
  });

  it('the grace after the time to pay is between 0 and 120 minutes, and falls back to five', () => {
    expect(readGatewayConfig({}).expiry.graceMinutes).toBe(5);
    expect(readGatewayConfig({ PAYMENT_EXPIRY_GRACE_MINUTES: '0' }).expiry.graceMinutes).toBe(0);
    expect(readGatewayConfig({ PAYMENT_EXPIRY_GRACE_MINUTES: '120' }).expiry.graceMinutes).toBe(120);
    expect(readGatewayConfig({ PAYMENT_EXPIRY_GRACE_MINUTES: '121' }).expiry.graceMinutes).toBe(5);
    expect(readGatewayConfig({ PAYMENT_EXPIRY_GRACE_MINUTES: '-5' }).expiry.graceMinutes).toBe(5);
    expect(readGatewayConfig({ PAYMENT_EXPIRY_GRACE_MINUTES: 'abc' }).expiry.graceMinutes).toBe(5);
  });

  it('the timer is on unless it is turned off, and never on in a test', () => {
    expect(readGatewayConfig({}).expiry.workerEnabled).toBe(true);
    expect(readGatewayConfig({ PAYMENT_EXPIRY_WORKER: 'off' }).expiry.workerEnabled).toBe(false);
    expect(readGatewayConfig({ PAYMENT_EXPIRY_WORKER: '0' }).expiry.workerEnabled).toBe(false);
    expect(readGatewayConfig({ NODE_ENV: 'test' }).expiry.workerEnabled).toBe(false);
  });

  it('nothing is a problem until a provider is chosen; a chosen provider needs its settings', () => {
    expect(gatewayConfigProblems({})).toEqual([]);
    expect(gatewayConfigProblems({ PAYMENT_PROVIDER: 'none' })).toEqual([]);
    expect(gatewayConfigProblems(ENV)).toEqual([]);

    const bare = gatewayConfigProblems({ PAYMENT_PROVIDER: 'konnect' }).join(' | ');

    expect(bare).toContain('KONNECT_API_KEY is required');
    expect(bare).toContain('KONNECT_WALLET_ID is required');
    expect(bare).toContain('API_PUBLIC_URL is required');
  });

  it('refuses a provider it does not know, a clock out of range, and an address that is not one', () => {
    expect(gatewayConfigProblems({ PAYMENT_PROVIDER: 'stripe' }).join(' ')).toContain('PAYMENT_PROVIDER must be');
    expect(gatewayConfigProblems({ PAYMENT_LIFESPAN_MINUTES: '2' }).join(' ')).toContain('between 5 and 180');
    expect(gatewayConfigProblems({ PAYMENT_LIFESPAN_MINUTES: '181' }).join(' ')).toContain('between 5 and 180');
    expect(gatewayConfigProblems({ PAYMENT_LIFESPAN_MINUTES: '180' })).toEqual([]);
    expect(MAX_LIFESPAN_MINUTES).toBe(180);
    expect(gatewayConfigProblems({ PAYMENT_LIFESPAN_MINUTES: 'soon' }).join(' ')).toContain('whole number');
    expect(gatewayConfigProblems({ ...ENV, API_PUBLIC_URL: 'not a url' }).join(' ')).toContain('API_PUBLIC_URL is not a valid URL');
    expect(gatewayConfigProblems({ ...ENV, KONNECT_API_URL: 'ftp://x.test' }).join(' ')).toContain('KONNECT_API_URL must start with https://');
  });

  it('the address of the server is the address without its /api, with no user name, query or fragment (the webhook path is added to it)', () => {
    for (const bad of ['https://api.example.test/api', 'https://api.example.test/api/', 'https://api.example.test/v1/API//', 'https://user:pw@api.example.test', 'https://:pw@api.example.test', 'https://api.example.test?x=1', 'https://api.example.test/#top']) {
      expect(gatewayConfigProblems({ ...ENV, API_PUBLIC_URL: bad }).length).toBeGreaterThan(0);
    }

    expect(gatewayConfigProblems({ ...ENV, API_PUBLIC_URL: 'https://api.example.test/api' }).join(' ')).toContain('without its /api');
    expect(gatewayConfigProblems({ ...ENV, API_PUBLIC_URL: 'https://user:pw@api.example.test' }).join(' ')).toContain('user name');
    expect(gatewayConfigProblems({ ...ENV, API_PUBLIC_URL: 'https://:pw@api.example.test' }).join(' ')).toContain('user name');
    expect(gatewayConfigProblems({ ...ENV, API_PUBLIC_URL: 'https://api.example.test?x=1' }).join(' ')).toContain('query');

    for (const good of ['https://api.example.test', 'https://api.example.test/', 'https://example.test/backend', 'https://api.example.test/capital']) {
      expect(gatewayConfigProblems({ ...ENV, API_PUBLIC_URL: good })).toEqual([]);
    }

    // the provider's own address (it has a path of its own) is not held to it
    expect(gatewayConfigProblems({ ...ENV, KONNECT_API_URL: 'https://api.konnect.network/api/v2' })).toEqual([]);
    expect(gatewayConfigProblems({ ...ENV, KONNECT_API_URL: 'https://api.konnect.network/api' })).toEqual([]);
  });

  it('plain http is accepted outside production only (the webhook of a developer machine), never in production', () => {
    expect(gatewayConfigProblems({ ...ENV, API_PUBLIC_URL: 'http://localhost:3000' })).toEqual([]);
    expect(gatewayConfigProblems({ ...ENV, API_PUBLIC_URL: 'http://localhost:3000', NODE_ENV: 'production' }).join(' ')).toContain('API_PUBLIC_URL must start with https://');
  });

  it('the start-up check of the server lists them with the others', () => {
    const base = { DATABASE_URL: 'postgres://x', JWT_ACCESS_SECRET: 'a'.repeat(20), JWT_REFRESH_SECRET: 'b'.repeat(20), FRONTEND_URL: 'https://site.example.test' };

    expect(() => validateEnv({ ...base })).not.toThrow();
    expect(() => validateEnv({ ...base, PAYMENT_PROVIDER: 'konnect' })).toThrow(/KONNECT_API_KEY is required/);
    expect(() => validateEnv({ ...base, ...ENV })).not.toThrow();
  });

  it('the service says whether a card payment can be made, and where the provider calls', () => {
    const none = new PaymentGatewayService(readGatewayConfig({}));
    const konnect = new PaymentGatewayService(readGatewayConfig(ENV));

    expect(none.connected()).toBe(false);
    expect(none.provider()).toBeNull();
    expect(konnect.connected()).toBe(true);
    expect(konnect.provider()).toBe('KONNECT');
    expect(konnect.routeName()).toBe('konnect');
    expect(konnect.webhookUrl()).toBe('https://api.example.test/api/payments/webhooks/konnect');
  });

  it('without a provider, asking one is an error that says so (and is not worth a retry)', async () => {
    const error = await refusal(() => new PaymentGatewayService(readGatewayConfig({})).status('x'));

    expect(error instanceof GatewayError).toBe(true);
    expect(error.retryable).toBe(false);
  });
});

describe('the Konnect adapter (P2-10)', () => {
  it('asks for a payment: the key in the header, the amount in millimes, our name for the payment, the three addresses', async () => {
    const { adapter: konnect, calls } = adapter([{ body: { payUrl: 'https://pay.example.test/pay?payment_ref=abc123', paymentRef: 'abc123' } }]);
    const created = await konnect.create(INPUT);

    expect(created).toEqual({ providerPaymentId: 'abc123', payUrl: 'https://pay.example.test/pay?payment_ref=abc123' });
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(`${API}/payments/init-payment`);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers['x-api-key']).toBe('key-secret-123');

    const body = JSON.parse(calls[0].init.body);

    expect(body.amount).toBe(12345);
    expect(body.token).toBe('TND');
    expect(body.receiverWalletId).toBe('wallet-1');
    expect(body.orderId).toBe('DEP-12-P34');
    expect(body.lifespan).toBe(30);
    expect(body.type).toBe('immediate');
    expect(body.webhook).toBe(INPUT.webhookUrl);
    expect(body.successUrl).toBe(INPUT.successUrl);
    expect(body.failUrl).toBe(INPUT.failUrl);
    expect(body.acceptedPaymentMethods).toEqual(['bank_card', 'e-DINAR']);
    expect(body.firstName).toBe('Sami');
    expect(body.lastName).toBe('Ben Ali');
    // nothing else about the customer is sent
    expect(body.email).toBeUndefined();
    expect(body.phoneNumber).toBeUndefined();
  });

  it('a customer with no name sends no name', async () => {
    const { adapter: konnect, calls } = adapter([{ body: { payUrl: 'https://pay.example.test/x', paymentRef: 'r1' } }]);

    await konnect.create({ ...INPUT, customer: { name: '  ' } });

    const body = JSON.parse(calls[0].init.body);

    expect(body.firstName).toBeUndefined();
    expect(body.lastName).toBeUndefined();
  });

  it('an answer without a number, or with a page that is not https, is not a payment', async () => {
    for (const body of [{ payUrl: 'https://pay.example.test/x' }, { paymentRef: 'r1' }, { payUrl: 'http://pay.example.test/x', paymentRef: 'r1' }, { payUrl: 'javascript:alert(1)', paymentRef: 'r1' }, { payUrl: 'https://pay.example.test/x', paymentRef: '../admin' }]) {
      const error = await refusal(() => adapter([{ body }]).adapter.create(INPUT));

      expect(error instanceof GatewayError).toBe(true);
      expect(error.retryable).toBe(false);
    }
  });

  it('the page the customer is sent to must be an https address of a host: no user name, no space, no backslash, not endless', async () => {
    for (const bad of ['https://pay.example.test@evil.example/x', 'https://pay.example.test/a b', 'https://pay.example.test/a\nb', 'https://evil.example\\.pay.example.test/x', 'https://pay.example.test/a\\b', 'https://', 'https:///x', 'http://pay.example.test/x', `https://pay.example.test/${'a'.repeat(2000)}`]) {
      const error = await refusal(() => adapter([{ body: { payUrl: bad, paymentRef: 'r1' } }]).adapter.create(INPUT));

      expect(error instanceof GatewayError).toBe(true);
      expect(isPayPage(bad)).toBe(false);
    }

    for (const good of ['https://pay.example.test/pay?payment_ref=r1', 'https://pay.example.test', 'HTTPS://PAY.EXAMPLE.TEST:8443/x#y']) {
      expect(isPayPage(good)).toBe(true);
      expect((await adapter([{ body: { payUrl: good, paymentRef: 'r1' } }]).adapter.create(INPUT)).payUrl).toBe(good);
    }

    for (const notText of [null, undefined, 5, {}, ['https://pay.example.test/x']]) expect(isPayPage(notText)).toBe(false);
  });

  it('a refused key is not worth a retry, a server error and a network error are', async () => {
    const refused = await refusal(() => adapter([{ status: 401 }]).adapter.create(INPUT));
    const down = await refusal(() => adapter([{ status: 503 }]).adapter.create(INPUT));
    const slow = await refusal(() => adapter([{ status: 429 }]).adapter.create(INPUT));
    const cut = await refusal(() => adapter([{ throws: Object.assign(new Error('connect ECONNREFUSED https://konnect.example.test key-secret-123'), { code: 'ECONNREFUSED' }) }]).adapter.create(INPUT));
    const timeout = await refusal(() => adapter([{ throws: Object.assign(new Error('aborted'), { name: 'AbortError' }) }]).adapter.create(INPUT));

    expect(refused.retryable).toBe(false);
    expect(down.retryable).toBe(true);
    expect(slow.retryable).toBe(true);
    expect(cut.retryable).toBe(true);
    expect(timeout.retryable).toBe(true);
    // the error never carries the address, the key or the text the network gave
    for (const error of [refused, down, cut, timeout]) {
      expect(error.message).not.toContain('key-secret-123');
      expect(error.message).not.toContain('konnect.example.test');
    }
  });

  it('reads the status of a payment: the state, the amount in dinars, the currency and our name for it', async () => {
    const { adapter: konnect, calls } = adapter([{ body: { payment: { status: 'completed', amount: 12345, token: 'tnd', orderId: 'DEP-12-P34' } } }]);
    const status = await konnect.status('abc123');

    expect(status).toEqual({ providerPaymentId: 'abc123', state: 'PAID', amount: 12.345, currency: 'TND', orderId: 'DEP-12-P34' });
    expect(calls[0].url).toBe(`${API}/payments/abc123`);
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.headers['x-api-key']).toBe('key-secret-123');
  });

  it('reads the words of the provider; a word it does not know is "still waiting", never a payment or a failure', () => {
    expect(konnectState('completed')).toBe('PAID');
    expect(konnectState(' Completed ')).toBe('PAID');
    expect(konnectState('pending')).toBe('PENDING');
    expect(konnectState('expired')).toBe('EXPIRED');
    expect(konnectState('failed')).toBe('FAILED');
    expect(konnectState('declined')).toBe('FAILED');
    expect(konnectState('something-new')).toBe('PENDING');
    expect(konnectState('')).toBe('PENDING');
    expect(konnectState(undefined)).toBe('PENDING');
    expect(konnectState(1)).toBe('PENDING');
  });

  it('an amount that is not a whole number of millimes is not trusted: it is no amount', async () => {
    for (const amount of [12.5, -3, 'abc', null, undefined, {}]) {
      const status = await adapter([{ body: { payment: { status: 'completed', amount, token: 'TND' } } }]).adapter.status('abc123');

      expect(status.amount).toBeNull();
    }

    // a number in a text is read (the provider may write it so)
    expect((await adapter([{ body: { payment: { status: 'completed', amount: '12345' } } }]).adapter.status('abc123')).amount).toBe(12.345);
  });

  it('the answer may carry the payment at its top or in "payment"; one that is neither is an error to retry', async () => {
    expect((await adapter([{ body: { status: 'pending', amount: 1000 } }]).adapter.status('r1')).state).toBe('PENDING');

    const error = await refusal(() => adapter([{ raw: 'not json' }]).adapter.status('r1'));

    expect(error instanceof GatewayError).toBe(true);
    expect(error.retryable).toBe(true);
  });

  it('a payment the provider does not know is an error that is not worth a retry; a number that is not a number of the provider is never sent', async () => {
    const unknown = await refusal(() => adapter([{ status: 404 }]).adapter.status('nope'));

    expect(unknown.retryable).toBe(false);

    const { adapter: konnect, calls } = adapter([{ body: {} }]);
    const injected = await refusal(() => konnect.status('../payments/other'));

    expect(injected instanceof GatewayError).toBe(true);
    expect(calls.length).toBe(0);
  });

  it('reads which payment a webhook is about: the query or the body, and only a plausible number', () => {
    const konnect = adapter([]).adapter;

    expect(konnect.readNotification({ query: { payment_ref: 'abc123' }, body: undefined })).toBe('abc123');
    expect(konnect.readNotification({ query: {}, body: { payment_ref: 'abc123' } })).toBe('abc123');
    expect(konnect.readNotification({ query: {}, body: { paymentRef: 'abc123' } })).toBe('abc123');
    expect(konnect.readNotification({ query: {}, body: undefined })).toBeNull();
    expect(konnect.readNotification({ query: { payment_ref: ['a', 'b'] }, body: undefined })).toBeNull();
    expect(konnect.readNotification({ query: { payment_ref: '../x' }, body: undefined })).toBeNull();
    expect(konnect.readNotification({ query: { payment_ref: 'a b' }, body: undefined })).toBeNull();
    expect(konnect.readNotification({ query: { payment_ref: 'x'.repeat(101) }, body: undefined })).toBeNull();
    expect(konnect.readNotification({ query: { payment_ref: 5 }, body: 'text' })).toBeNull();
  });
});

describe('the gateway in detail (P2-10)', () => {
  it('asks for the payment with no fees added to the amount, no form of the provider, and a notification that is silent', async () => {
    const { adapter: konnect, calls } = adapter([{ body: { payUrl: 'https://pay.example.test/x', paymentRef: 'r1' } }]);

    await konnect.create(INPUT);

    const body = JSON.parse(calls[0].init.body);

    expect(body.addPaymentFeesToAmount).toBe(false);
    expect(body.checkoutForm).toBe(false);
    expect(body.silentWebhook).toBe(true);
    expect(body.description).toBe('Dépannage n° 12');
    expect(calls[0].init.headers['content-type']).toBe('application/json');
  });

  it('reads every word of the provider that means paid, failed or expired', () => {
    for (const word of ['completed', 'paid', 'success', 'succeeded', 'COMPLETED']) expect(konnectState(word)).toBe('PAID');
    for (const word of ['failed', 'failure', 'declined', 'rejected', 'canceled', 'cancelled', ' Cancelled ']) expect(konnectState(word)).toBe('FAILED');
    for (const word of ['expired', 'Expired']) expect(konnectState(word)).toBe('EXPIRED');
    for (const word of ['pending', 'processing', 'created', 'new', null, {}]) expect(konnectState(word)).toBe('PENDING');
  });

  it('puts the number of a payment in the address as an encoded value', async () => {
    const { adapter: konnect, calls } = adapter([{ body: { payment: { status: 'pending' } } }]);

    await konnect.status('a:b');

    expect(calls[0].url).toBe(`${API}/payments/a%3Ab`);
  });

  it('a provider that is not one we know is no provider', () => {
    for (const name of ['flouci', 'paymee', 'stripe', 'true', '1']) {
      expect(readGatewayConfig({ PAYMENT_PROVIDER: name }).provider).toBe('none');
      expect(gatewayConnected(readGatewayConfig({ PAYMENT_PROVIDER: name }))).toBe(false);
    }

    expect(readGatewayConfig({ PAYMENT_PROVIDER: ' Konnect ' }).provider).toBe('konnect');
  });

  it('a gateway with no adapter behind it is not connected, whatever the configuration says, and reads no notification', () => {
    const service = new PaymentGatewayService(readGatewayConfig(ENV), null);

    expect(service.connected()).toBe(false);
    expect(service.provider()).toBeNull();
    expect(service.routeName()).toBeNull();
    expect(service.readNotification({ query: { payment_ref: 'abc' }, body: undefined })).toBeNull();
  });
});

describe('what the review of the gateway asked for (P2-10)', () => {
  it('the page of the customer must be on a host of the provider: its own host, or one of the same family', async () => {
    expect(isOnProviderHost('https://api.konnect.network/pay', 'https://api.konnect.network/api/v2')).toBe(true);
    expect(isOnProviderHost('https://gateway.konnect.network/pay?x=1', 'https://api.konnect.network/api/v2')).toBe(true);
    expect(isOnProviderHost('https://konnect.network/pay', 'https://api.konnect.network/api/v2')).toBe(true);
    expect(isOnProviderHost('https://GATEWAY.Konnect.Network/pay', 'https://api.konnect.network/api/v2')).toBe(true);

    for (const bad of ['https://evil.example/pay', 'https://konnect.network.evil.example/pay', 'https://evilkonnect.network/pay', 'https://network/pay']) {
      expect(isOnProviderHost(bad, 'https://api.konnect.network/api/v2')).toBe(false);
    }

    // an address, or a host of one name, is only matched exactly
    expect(isOnProviderHost('https://localhost/pay', 'http://localhost:3999/api')).toBe(true);
    expect(isOnProviderHost('https://other.localhost/pay', 'http://localhost:3999/api')).toBe(false);
    expect(isOnProviderHost('https://10.0.0.5/pay', 'http://10.0.0.5/api')).toBe(true);
    expect(isOnProviderHost('https://0.0.5/pay', 'http://10.0.0.5/api')).toBe(false);
    expect(isOnProviderHost('not a url', 'https://api.konnect.network')).toBe(false);
    expect(isOnProviderHost('https://pay.example.test/x', 'not a url')).toBe(false);
  });

  it('an answer whose page is on another site is not a payment: the customer is never sent there', async () => {
    const error = await refusal(() => adapter([{ body: { payUrl: 'https://evil.example/pay', paymentRef: 'r1' } }]).adapter.create(INPUT));

    expect(error instanceof GatewayError).toBe(true);
    expect(error.retryable).toBe(false);
    expect(error.code).toBe('BAD_ANSWER');
    expect(error.message).not.toContain('evil.example');
  });

  it('a redirect is an error, it is never followed: the key would go with it', async () => {
    const { adapter: konnect, calls } = adapter([{ body: { payUrl: 'https://pay.example.test/x', paymentRef: 'r1' } }, { body: { payment: { status: 'pending' } } }]);

    await konnect.create(INPUT);
    await konnect.status('r1');

    expect(calls.length).toBe(2);
    for (const call of calls) expect(call.init.redirect).toBe('error');
  });

  it('an amount written as hex, with an exponent or a sign, or beyond what a column holds, is no amount', async () => {
    for (const amount of ['0x2F58', '1e3', '+5', '-5', ' ', '12.0', '1,5', 1e21, 2 ** 53, 99_999_999_999_999 + 1, '1000000000000000', Number.NaN, Number.POSITIVE_INFINITY]) {
      const status = await adapter([{ body: { payment: { status: 'completed', amount, token: 'TND' } } }]).adapter.status('abc123');

      expect(status.amount).toBeNull();
    }

    // the largest a column holds, and a number written in a text with spaces around it, are read
    expect((await adapter([{ body: { payment: { status: 'completed', amount: 99_999_999_999_999 } } }]).adapter.status('abc123')).amount).toBe(99_999_999_999.999);
    expect((await adapter([{ body: { payment: { status: 'completed', amount: ' 12345 ' } } }]).adapter.status('abc123')).amount).toBe(12.345);
    expect((await adapter([{ body: { payment: { status: 'completed', amount: 0 } } }]).adapter.status('abc123')).amount).toBe(0);
  });

  it('a number of payment that starts with a sign, or is made of dots, is never looked up or read from a webhook', async () => {
    for (const bad of ['..', '.', '...', '.hidden', '-x', '_x', ':x']) {
      const { adapter: konnect, calls } = adapter([{ body: {} }]);
      const error = await refusal(() => konnect.status(bad));

      expect(error instanceof GatewayError).toBe(true);
      expect(calls.length).toBe(0);
      expect(konnect.readNotification({ query: { payment_ref: bad }, body: {} })).toBeNull();
    }

    for (const good of ['a', '5f7a1c', 'abc_DEF-1.2:3', 'a'.repeat(100)]) expect(adapter([]).adapter.readNotification({ query: { payment_ref: good }, body: {} })).toBe(good);
    expect(adapter([]).adapter.readNotification({ query: { payment_ref: 'a'.repeat(101) }, body: {} })).toBeNull();
  });

  it('every failure of the provider has a code that is safe to write down', async () => {
    const codes = async (answers: any[], work: (konnect: KonnectAdapter) => Promise<unknown>) => (await refusal(() => work(adapter(answers).adapter))).code;

    expect(await codes([{ status: 401 }], (k) => k.status('r1'))).toBe('REFUSED');
    expect(await codes([{ status: 403 }], (k) => k.create(INPUT))).toBe('REFUSED');
    expect(await codes([{ status: 404 }], (k) => k.status('r1'))).toBe('UNKNOWN_PAYMENT');
    expect(await codes([{ status: 502 }], (k) => k.status('r1'))).toBe('HTTP');
    expect(await codes([{ throws: Object.assign(new Error('boom key-secret-123'), { code: 'ECONNRESET' }) }], (k) => k.status('r1'))).toBe('NETWORK');
    expect(await codes([{ throws: Object.assign(new Error('x'), { name: 'AbortError' }) }], (k) => k.status('r1'))).toBe('TIMEOUT');
    expect(await codes([{ raw: 'not json' }], (k) => k.status('r1'))).toBe('BAD_ANSWER');
    expect(await codes([{ body: {} }], (k) => k.create(INPUT))).toBe('BAD_ANSWER');
    expect((await refusal(() => new PaymentGatewayService(readGatewayConfig({}), null).status('r1'))).code).toBe('NOT_SET_UP');

    // the code is a word of ours, and the message never repeats what the network said
    const error = await refusal(() => adapter([{ throws: Object.assign(new Error('boom key-secret-123'), { code: 'ECONNRESET' }) }]).adapter.status('r1'));

    expect(error.message).not.toContain('key-secret-123');
    expect(new GatewayError('x', true).code).toBe('HTTP');
  });

  it('the addresses are read as the parser reads them: no missing slash, no query, no fragment, no endless grace', () => {
    expect(normalizedAddress('https:/api.example.test')).toBe('https://api.example.test');
    expect(normalizedAddress('https://api.example.test///')).toBe('https://api.example.test');
    expect(normalizedAddress('https://Api.Example.test/base/')).toBe('https://api.example.test/base');
    expect(normalizedAddress('not an address//')).toBe('not an address');
    expect(readGatewayConfig({ ...ENV, API_PUBLIC_URL: 'https:/api.example.test' }).publicUrl).toBe('https://api.example.test');
    expect(readGatewayConfig({ ...ENV, KONNECT_API_URL: 'https://sandbox.example.test/api/v2//' }).konnect.apiUrl).toBe('https://sandbox.example.test/api/v2');

    for (const bad of ['https:/api.example.test', 'https:api.example.test', 'https:\\api.example.test']) {
      expect(gatewayConfigProblems({ ...ENV, API_PUBLIC_URL: bad }).join(' ')).toContain('https://');
    }

    for (const bad of ['https://k.example.test/api/v2?x=1', 'https://k.example.test/api/v2#top', 'https://k.example.test/api/v2?', 'https://k.example.test/api/v2#']) {
      expect(gatewayConfigProblems({ ...ENV, KONNECT_API_URL: bad }).join(' ')).toContain('query');
    }

    expect(gatewayConfigProblems({ ...ENV, PAYMENT_EXPIRY_GRACE_MINUTES: '99999' }).join(' ')).toContain('between 0 and 120');
    expect(gatewayConfigProblems({ ...ENV, PAYMENT_EXPIRY_GRACE_MINUTES: '120' })).toEqual([]);
    expect(gatewayConfigProblems({ ...ENV, PAYMENT_EXPIRY_GRACE_MINUTES: '121' }).join(' ')).toContain('between 0 and 120');
    expect(gatewayConfigProblems({ ...ENV, PAYMENT_LIFESPAN_MINUTES: '240' }).join(' ')).toContain(`between 5 and ${MAX_LIFESPAN_MINUTES}`);
    expect(MAX_LIFESPAN_MINUTES).toBe(180);
  });

  it('the documents of the settings say the same range as the code', () => {
    const fs = require('fs');
    const path = require('path');
    const example = fs.readFileSync(path.resolve(__dirname, '../../../../.env.example'), 'utf8');
    const config = fs.readFileSync(path.resolve(__dirname, 'gateway-config.ts'), 'utf8');

    expect(example).toContain(`5 to ${MAX_LIFESPAN_MINUTES}`);
    expect(config).toContain(`from 5 to ${MAX_LIFESPAN_MINUTES}`);
    expect(example).not.toContain('1440');
  });
});
