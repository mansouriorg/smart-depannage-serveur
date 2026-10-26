import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { World, emptyWorld } from '../../common/testing/world';
import { FakePaymentGateway } from '../../common/testing/fake-payment-gateway';
import { resetLocale } from '../../common/locale/locale';
import { paymentForArtisan, paymentForClient } from '../../common/views/views';
import { GuestService } from '../guest/guest.service';
import { readGatewayConfig } from './gateway/gateway-config';
import { GatewayError } from './gateway/payment-gateway';
import { PaymentGatewayService } from './gateway/payment-gateway.service';
import { CARD_WORDS, orderIdOf, startOnlinePayment } from './online-payment';
import { KEY_WORDS, asKeyConflict, readIdempotencyKey } from './idempotency';
import { PAID_WORDS as PAYMENT_WORDS_PAID, supersede } from './open-payment';
import { PaymentExpiryService } from './payment-expiry.service';
import { PaymentWebhooksController } from './payment-webhooks.controller';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PAYMENT_WORDS } from './payment-options';

/**
 * The card payment, from the request to the confirmation (P2-10), on the real services, a database that answers DECIMAL columns as
 * Decimal objects, and a provider that is a fake (it keeps what it was asked and answers what the spec made of it).
 */
const RIB = '08006012345678901234';
const LINK = 'link-of-a-visitor';
const ENV = { PAYMENT_PROVIDER: 'konnect', KONNECT_API_KEY: 'key-secret-123', KONNECT_WALLET_ID: 'wallet-1', API_PUBLIC_URL: 'https://api.example.test' };
const hashOf = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
const MINUTE = 60_000;

function desk(options: { connected?: boolean; quote?: number; status?: string; currency?: string; env?: Record<string, string> } = {}) {
  resetLocale();

  const world = emptyWorld();
  const client = world.memory.plant('user', { role: 'CLIENT', name: 'Sami Ben Ali', isGuest: true });
  const stranger = world.memory.plant('user', { role: 'CLIENT', name: 'Un autre client' });
  const admin = world.memory.plant('user', { role: 'ADMIN', name: 'Chef' });
  const artisan = world.memory.plant('user', { role: 'ARTISAN', name: 'Artisan' });

  world.memory.plant('artisanProfile', { userId: artisan.id, verificationStatus: 'APPROVED' });

  const job = world.memory.plant('intervention', { clientId: client.id, artisanId: artisan.id, status: options.status ?? 'COMPLETED', serviceType: 'PLOMBIER', trackingToken: hashOf(LINK) });
  const quote = world.memory.plant('quote', { interventionId: job.id, createdById: artisan.id, status: 'ACCEPTED', amountHT: options.quote ?? 119, taxAmount: 0, amountTTC: options.quote ?? 119, ...(options.currency ? { currency: options.currency } : {}) });

  world.memory.plant('companySettings', { companyName: 'Smart Dépannage', paymentMethods: ['ONLINE', 'CASH', 'BANK_TRANSFER'], rib: RIB });

  const connected = options.connected !== false;
  const gateway = new FakePaymentGateway();
  const service = new PaymentGatewayService(readGatewayConfig(connected ? { ...ENV, ...(options.env ?? {}) } : {}), connected ? gateway : null);
  const payments = new PaymentsService(world.prisma, world.svc.events, world.svc.told, service);
  const guest = new GuestService(world.prisma, world.svc.told, world.svc.events, world.svc.rateLimit, world.svc.staffAlerts, world.svc.files, world.svc.complaints, service, payments);
  const hooks = new PaymentWebhooksController(payments);

  return { world, client, stranger, admin, artisan, job, quote, gateway, service, payments, guest, hooks };
}

type Desk = ReturnType<typeof desk>;

const ask = (d: Desk, method = 'ONLINE_CARD', key?: string) => d.guest.createGuestPayment(d.job.id, LINK, { method } as any, key);
const askAsClient = (d: Desk, method = 'ONLINE_CARD', key?: string, who = d.client) => d.payments.createClientPaymentRequest(who.id, d.job.id, { method } as any, key);
const hook = (d: Desk, ref: string) => d.hooks.receiveGet('konnect', { payment_ref: ref });
const rowsOf = (d: Desk) => d.world.memory.rows('payment');
const only = (d: Desk) => {
  const rows = rowsOf(d);

  expect(rows.length).toBe(1);

  return rows[0];
};
const eventsOf = (d: Desk, type: string) => d.world.memory.rows('interventionEvent').filter((row) => row.type === type);
const told = (d: Desk, name: string) => d.world.sink.filter((call) => call === `notifications.${name}`).length;
const logOf = (d: Desk) => d.world.memory.rows('paymentWebhookLog').map((row) => row.outcome);
const jobStatus = (d: Desk) => d.world.memory.rows('intervention').find((row) => row.id === d.job.id)!.status;
const patch = (d: Desk, id: number, data: Record<string, unknown>) => d.world.prisma.payment.update({ where: { id }, data });
const lapse = (d: Desk, id: number, minutesAgo: number) => patch(d, id, { expiresAt: new Date(Date.now() - minutesAgo * MINUTE) });

async function refusal(work: () => Promise<unknown>): Promise<{ status: number; message: string } | null> {
  try {
    await work();
  } catch (error) {
    const known = error as { getStatus?: () => number; message?: string };

    return { status: typeof known.getStatus === 'function' ? known.getStatus() : 500, message: String(known.message) };
  }

  return null;
}

describe('asking for a card payment (P2-10)', () => {
  it('the request is recorded, then the provider is asked: the payment keeps its number, its page and its time', async () => {
    const d = desk();
    const before = Date.now();
    const answer: any = await ask(d);
    const payment = only(d);
    const ref = d.gateway.ref(1);

    expect(payment.status).toBe('PENDING');
    expect(payment.provider).toBe('KONNECT');
    expect(payment.providerPaymentId).toBe(ref);
    expect(payment.payUrl).toBe(`https://pay.example.test/pay?payment_ref=${ref}`);
    expect(payment.gatewayClaimedAt).toBeNull();
    expect(payment.expiresAt.getTime() - before).toBeGreaterThan(29 * MINUTE);
    expect(payment.expiresAt.getTime() - before).toBeLessThan(31 * MINUTE);

    // the customer is sent to the page of the provider
    expect(answer.payment.payUrl).toBe(payment.payUrl);
    expect(answer.payment.expiresAt).toEqual(payment.expiresAt);
    expect(answer.instructions).toContain('par carte');
    expect(answer.replayed).toBeUndefined();

    // what the provider was told: our name for the payment, the amount, the three addresses, nothing else about the customer
    expect(d.gateway.created.length).toBe(1);
    expect(d.gateway.created[0]).toEqual({
      orderId: orderIdOf(payment),
      amount: 119,
      currency: 'TND',
      description: `Dépannage n° ${d.job.id}`,
      lifespanMinutes: 30,
      successUrl: `${process.env.FRONTEND_URL}/paiement/retour`,
      failUrl: `${process.env.FRONTEND_URL}/paiement/retour`,
      webhookUrl: 'https://api.example.test/api/payments/webhooks/konnect',
      customer: { name: null },
    });
    expect(orderIdOf(payment)).toBe(`DEP-${d.job.id}-P${payment.id}`);

    // the job waits for the payment, and the timeline says so
    expect(jobStatus(d)).toBe('PAYMENT_PENDING');
    expect(eventsOf(d, 'PAYMENT_PENDING').length).toBe(1);
    expect(eventsOf(d, 'PAYMENT_PENDING')[0].message).toContain('page de paiement');
  });

  it('a card is paid in the currency of the company: a job in another currency refuses the card request (both ways in), offers no card, and asks the provider nothing', async () => {
    const d = desk({ currency: 'EUR' });

    expect((await refusal(() => ask(d)))?.status).toBe(400);
    expect((await refusal(() => askAsClient(d)))?.status).toBe(400);
    expect((await refusal(() => ask(d)))?.message).toBe(PAYMENT_WORDS.cardCurrency);
    expect(d.gateway.created.length).toBe(0);
    expect(rowsOf(d).length).toBe(0);

    const options: any = await d.guest.getPaymentOptions(d.job.id, LINK);
    const card = options.methods.find((item: any) => item.method === 'ONLINE_CARD');

    expect(card.available).toBe(false);
    expect(card.reason).toBe(PAYMENT_WORDS.cardCurrency);
    expect(options.methods.find((item: any) => item.method === 'CASH').available).toBe(true);

    // the company's own currency is paid by card as before; and without a provider nothing changes for either
    expect(((await ask(desk())) as any).payment.status).toBe('PENDING');
    expect(((await ask(desk({ currency: 'EUR', connected: false }))) as any).payment.status).toBe('PENDING');
  });

  it('the same request again is the same payment: one payment at the provider, the same page, and it says it is a repeat', async () => {
    const d = desk();
    const first: any = await ask(d);
    const second: any = await ask(d);

    expect(only(d).id).toBe(first.payment.id);
    expect(second.payment.id).toBe(first.payment.id);
    expect(second.payment.payUrl).toBe(first.payment.payUrl);
    expect(second.replayed).toBe(true);
    expect(d.gateway.created.length).toBe(1);
    expect(eventsOf(d, 'PAYMENT_PENDING').length).toBe(1);
  });

  it('two requests at the same moment: one payment at the provider, and both get its page', async () => {
    const d = desk();
    let release: () => void = () => undefined;

    d.gateway.hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = ask(d);
    const second = ask(d);

    setTimeout(release, 40);

    const [a, b]: any[] = await Promise.all([first, second]);

    expect(d.gateway.created.length).toBe(1);
    expect(only(d).providerPaymentId).toBe(d.gateway.ref(1));
    expect(a.payment.payUrl).toBe(b.payment.payUrl);
    expect(a.payment.payUrl).toContain('fake-ref-1');
  });

  it('a request that is claimed by a dead asker is taken over once the claim is old', async () => {
    const d = desk();

    // the request is recorded and nobody started it; a claim made two minutes ago by a process that died
    const payment = d.world.memory.plant('payment', { interventionId: d.job.id, method: 'ONLINE_CARD', provider: 'MANUAL', status: 'PENDING', amount: 119, currency: 'TND', gatewayClaimedAt: new Date(Date.now() - 2 * MINUTE) });
    const started = await startOnlinePayment(d.world.prisma, d.service, payment);

    expect(started.providerPaymentId).toBe(d.gateway.ref(1));
  });

  it('a request that is being started by someone else, and does not come back in time, is told to try again in a moment', async () => {
    const d = desk();
    const payment = d.world.memory.plant('payment', { interventionId: d.job.id, method: 'ONLINE_CARD', provider: 'MANUAL', status: 'PENDING', amount: 119, currency: 'TND', gatewayClaimedAt: new Date() });
    const waits: number[] = [];
    const problem = await refusal(() => startOnlinePayment(d.world.prisma, d.service, payment, { waitMs: 500, wait: async (ms) => void waits.push(ms) }));

    expect(problem).toEqual({ status: 409, message: CARD_WORDS.preparing });
    expect(waits.length).toBeGreaterThan(1);
    expect(d.gateway.created.length).toBe(0);
  });

  it('a provider that does not answer: the customer is told, the request stays, and asking again starts it', async () => {
    const d = desk();

    d.gateway.createFails = new GatewayError('down', true);

    const problem = await refusal(() => ask(d));

    expect(problem).toEqual({ status: 503, message: CARD_WORDS.unavailable });

    // the request is there, with nobody behind it, and nobody holds it
    const waiting = only(d);

    expect(waiting.status).toBe('PENDING');
    expect(waiting.providerPaymentId).toBeNull();
    expect(waiting.gatewayClaimedAt).toBeNull();

    d.gateway.createFails = null;

    const answer: any = await ask(d);

    expect(only(d).id).toBe(waiting.id);
    expect(answer.payment.payUrl).toContain('fake-ref-1');
    expect(d.gateway.created.length).toBe(1);
    expect(eventsOf(d, 'PAYMENT_PENDING').length).toBe(1);
  });

  it('a card request a provider did not take can be replaced by another way of paying', async () => {
    const d = desk();

    d.gateway.createFails = new GatewayError('down', true);
    await refusal(() => ask(d));

    const cash: any = await ask(d, 'CASH');
    const rows = rowsOf(d);

    expect(cash.payment.method).toBe('CASH');
    expect(rows.map((row) => row.status).sort()).toEqual(['AWAITING_CONFIRMATION', 'CANCELLED']);
  });

  it('a card payment a provider took stands in the way of the other ways, with the sentence the options give', async () => {
    const d = desk();

    await ask(d);

    const options: any = await d.guest.getPaymentOptions(d.job.id, LINK);
    const problem = await refusal(() => ask(d, 'CASH'));

    expect(options.open.method).toBe('ONLINE_CARD');
    expect(options.open.payUrl).toContain('fake-ref-1');
    expect(options.methods.find((choice: any) => choice.method === 'CASH').available).toBe(false);
    expect(problem?.status).toBe(409);
    expect(problem?.message).toContain('déjà en attente');
    expect(options.methods.find((choice: any) => choice.method === 'CASH').reason).toBe(problem?.message);
  });

  it('with a provider the options offer the card; without one they say it is not available, and the request is only recorded', async () => {
    const withProvider = desk();
    const options: any = await withProvider.guest.getPaymentOptions(withProvider.job.id, LINK);

    expect(options.methods.find((choice: any) => choice.method === 'ONLINE_CARD')).toEqual({ method: 'ONLINE_CARD', available: true, reason: null });

    const without = desk({ connected: false });
    const closed: any = await without.guest.getPaymentOptions(without.job.id, LINK);

    expect(closed.methods.find((choice: any) => choice.method === 'ONLINE_CARD')).toEqual({ method: 'ONLINE_CARD', available: false, reason: PAYMENT_WORDS.noProvider });

    const answer: any = await ask(without);
    const payment = only(without);

    expect(payment.provider).toBe('MANUAL');
    expect(payment.providerPaymentId).toBeNull();
    expect(answer.payment.payUrl).toBeNull();
    expect(answer.instructions).toContain('non connecté');
    expect(eventsOf(without, 'PAYMENT_PENDING')[0].message).toContain('Aucun prestataire externe');
    expect(without.gateway.created.length).toBe(0);
  });

  it('a customer who is signed in is sent to the provider in the same way', async () => {
    const d = desk();
    const answer: any = await askAsClient(d);
    const payment = only(d);

    expect(payment.provider).toBe('KONNECT');
    expect(answer.payUrl).toBe(payment.payUrl);
    expect(answer.instructions).toContain('par carte');

    const again: any = await askAsClient(d);

    expect(again.replayed).toBe(true);
    expect(again.payUrl).toBe(payment.payUrl);
    expect(d.gateway.created.length).toBe(1);
  });

  it('who takes the money is not for the payer to say: a provider named in the request is ignored', async () => {
    const d = desk();

    await d.payments.createClientPaymentRequest(d.client.id, d.job.id, { method: 'CASH', provider: 'KONNECT' } as any);

    expect(only(d).provider).toBe('CASH');
  });

  it('a way of paying that is not a card never goes to the provider', async () => {
    const d = desk();

    await ask(d, 'CASH');

    expect(d.gateway.created.length).toBe(0);
    expect(only(d).providerPaymentId).toBeNull();
  });
});

describe('a card payment is confirmed by the provider, once (P2-10)', () => {
  it('a card payment confirms once by webhook, even if the webhook is delivered twice', async () => {
    const d = desk();

    await ask(d);

    const ref = d.gateway.ref(1);

    d.gateway.settle(ref, 'PAID');

    expect(await hook(d, ref)).toEqual({ received: true });

    const confirmedAt = only(d).confirmedAt;

    expect(await hook(d, ref)).toEqual({ received: true });

    const payment = only(d);

    expect(payment.status).toBe('PAID');
    expect(payment.confirmedAt).toBe(confirmedAt);
    expect(payment.confirmedById).toBeNull();
    expect(payment.receiptNumber).toMatch(/^RCPT-\d{4}-\d{6}$/);
    expect(payment.payUrl).toBeNull();
    expect(jobStatus(d)).toBe('PAID');
    expect(d.world.memory.rows('interventionFinancials').length).toBe(1);

    // one confirmation: one line of the timeline, one set of notices, one question to the provider
    expect(eventsOf(d, 'PAYMENT_CONFIRMED').length).toBe(1);
    expect(told(d, 'notifyPaymentReceived')).toBe(1);
    expect(d.gateway.statusCalls).toBe(1);
    expect(logOf(d)).toEqual(['CONFIRMED', 'ALREADY']);
  });

  it('the same webhook at the same moment, three times: one confirmation', async () => {
    const d = desk();

    await ask(d);
    d.gateway.settle(d.gateway.ref(1), 'PAID');

    const answers = await Promise.all([hook(d, d.gateway.ref(1)), hook(d, d.gateway.ref(1)), hook(d, d.gateway.ref(1))]);

    expect(answers).toEqual([{ received: true }, { received: true }, { received: true }]);
    expect(only(d).status).toBe('PAID');
    expect(eventsOf(d, 'PAYMENT_CONFIRMED').length).toBe(1);
    expect(told(d, 'notifyPaymentReceived')).toBe(1);
    expect(d.world.memory.rows('interventionFinancials').length).toBe(1);
    expect(logOf(d).filter((outcome) => outcome === 'CONFIRMED').length).toBe(1);
  });

  it('a webhook is a reason to ask, not a proof: a call while the provider says the payment waits changes nothing', async () => {
    const d = desk();

    await ask(d);
    await hook(d, d.gateway.ref(1));

    const payment = only(d);

    expect(payment.status).toBe('PENDING');
    expect(payment.providerCheckedAt).toBeInstanceOf(Date);
    expect(jobStatus(d)).toBe('PAYMENT_PENDING');
    expect(eventsOf(d, 'PAYMENT_CONFIRMED').length).toBe(0);
    expect(logOf(d)).toEqual(['PENDING']);
  });

  it('what the provider says decides, not what the call says: a call that names a number the provider has not paid confirms nothing', async () => {
    const d = desk();

    await ask(d);
    await d.hooks.receivePost('konnect', {}, { payment_ref: d.gateway.ref(1), status: 'completed', amount: 119000 });

    expect(only(d).status).toBe('PENDING');
  });

  it('a call about a payment we do not know is answered like any other, and writes nothing at all (a row each would be a way to fill the table)', async () => {
    const d = desk();

    await ask(d);

    expect(await hook(d, 'zzz-unknown')).toEqual({ received: true });
    expect(only(d).status).toBe('PENDING');
    expect(d.gateway.statusCalls).toBe(0);
    expect(logOf(d)).toEqual([]);
  });

  it('a payment of another provider with the same number is not this provider\'s', async () => {
    const d = desk();

    d.world.memory.plant('payment', { interventionId: d.job.id, method: 'BANK_TRANSFER', provider: 'BANK_TRANSFER', status: 'AWAITING_CONFIRMATION', amount: 5, currency: 'TND', providerPaymentId: 'ext-77' });

    await hook(d, 'ext-77');

    expect(d.gateway.statusCalls).toBe(0);
    // not found as a payment of this provider: nothing is asked and nothing is written
    expect(logOf(d)).toEqual([]);
    expect(d.world.memory.rows('paymentWebhookLog')).toHaveLength(0);
  });

  it('a call with no payment number is refused (400); a provider that is not the one we use, or no provider at all, is not found (404)', async () => {
    const d = desk();

    expect((await refusal(() => d.hooks.receiveGet('konnect', {})))?.status).toBe(400);
    expect((await refusal(() => d.hooks.receiveGet('konnect', { payment_ref: '../etc' })))?.status).toBe(400);
    expect((await refusal(() => d.hooks.receiveGet('flouci', { payment_ref: 'abc' })))?.status).toBe(404);

    const none = desk({ connected: false });

    expect((await refusal(() => none.hooks.receiveGet('konnect', { payment_ref: 'abc' })))?.status).toBe(404);
  });

  it('the call also comes as a POST', async () => {
    const d = desk();

    await ask(d);
    d.gateway.settle(d.gateway.ref(1), 'PAID');

    expect(await d.hooks.receivePost('konnect', {}, { payment_ref: d.gateway.ref(1) })).toEqual({ received: true });
    expect(only(d).status).toBe('PAID');
  });

  it('a provider that cannot be reached when it calls: it is told to call again (503), nothing changes, and the next call confirms', async () => {
    const d = desk();

    await ask(d);
    d.gateway.settle(d.gateway.ref(1), 'PAID');
    d.gateway.statusFails = new GatewayError('down', true);

    expect((await refusal(() => hook(d, d.gateway.ref(1))))?.status).toBe(503);
    expect(only(d).status).toBe('PENDING');
    expect(logOf(d)).toEqual(['UNREACHABLE']);

    d.gateway.statusFails = null;
    await hook(d, d.gateway.ref(1));

    expect(only(d).status).toBe('PAID');
    expect(logOf(d)).toEqual(['UNREACHABLE', 'CONFIRMED']);
  });

  it('the provider says the payment failed: it fails once, the customer can ask again', async () => {
    const d = desk();

    await ask(d);
    d.gateway.settle(d.gateway.ref(1), 'FAILED');
    await hook(d, d.gateway.ref(1));
    await hook(d, d.gateway.ref(1));

    const payment = only(d);

    expect(payment.status).toBe('FAILED');
    expect(payment.failureReason).toBe(CARD_WORDS.refused);
    expect(payment.payUrl).toBeNull();
    expect(eventsOf(d, 'STATUS_CHANGED').filter((event) => event.title === 'Paiement échoué').length).toBe(1);

    const again: any = await ask(d);

    expect(again.payment.id).not.toBe(payment.id);
    expect(again.payment.payUrl).toContain('fake-ref-2');
  });

  it('the provider says the time is over: the payment is cancelled, and the customer can ask again', async () => {
    const d = desk();

    await ask(d);
    d.gateway.settle(d.gateway.ref(1), 'EXPIRED');
    await hook(d, d.gateway.ref(1));

    const payment = only(d);

    expect(payment.status).toBe('CANCELLED');
    expect(payment.cancelReason).toBe(CARD_WORDS.expired);
    expect(eventsOf(d, 'CANCELLED').length).toBe(1);
    expect((await ask(d) as any).payment.id).not.toBe(payment.id);
  });
});

describe('money that came and cannot be counted as it is goes to the team, never lost (P2-10)', () => {
  const put = async (d: Desk, details: Record<string, unknown> = {}) => {
    await ask(d);
    d.gateway.settle(d.gateway.ref(1), 'PAID', details);
    await hook(d, d.gateway.ref(1));
  };

  it('another amount than the one asked: the payment waits for a person, with the reason, and the job is not paid', async () => {
    const d = desk();

    await put(d, { amount: 100 });

    const payment = only(d);

    expect(payment.status).toBe('AWAITING_CONFIRMATION');
    expect(payment.adminNote).toContain('au lieu de');
    expect(payment.confirmedAt).toBeNull();
    expect(jobStatus(d)).toBe('PAYMENT_PENDING');
    expect(eventsOf(d, 'PAYMENT_CONFIRMED').length).toBe(0);
    expect(told(d, 'notifyPaymentReceived')).toBe(0);
    expect(told(d, 'notifyPaymentToCheck')).toBe(1);
    expect(logOf(d)).toEqual(['REVIEW']);
  });

  it('a provider that does not say the amount, the currency, or the order that was asked: the same', async () => {
    for (const details of [{ amount: null }, { currency: 'EUR' }, { orderId: 'DEP-9999-P1' }]) {
      const d = desk();

      await put(d, details);

      expect(only(d).status).toBe('AWAITING_CONFIRMATION');
      expect(jobStatus(d)).toBe('PAYMENT_PENDING');
    }
  });

  it('more money than asked is not counted either: it waits for a person', async () => {
    const d = desk();

    await put(d, { amount: 150 });

    expect(only(d).status).toBe('AWAITING_CONFIRMATION');
    expect(only(d).adminNote).toContain('au lieu de');
    expect(jobStatus(d)).toBe('PAYMENT_PENDING');
    expect(told(d, 'notifyPaymentReceived')).toBe(0);
  });

  it('a provider that does not say the amount: the note says so', async () => {
    const d = desk();

    await put(d, { amount: null });

    expect(only(d).adminNote).toContain('n’a pas indiqué le montant');
  });

  it('a provider that does not echo the currency, or the order, still confirms a payment whose amount is right (only a different one goes to a person)', async () => {
    for (const details of [{ currency: null }, { orderId: null }]) {
      const d = desk();

      await put(d, details);

      expect(only(d).status).toBe('PAID');
    }
  });

  it('a second call about it changes nothing and tells nobody again', async () => {
    const d = desk();

    await put(d, { amount: 100 });

    // at once: held back by the pause, the provider is not asked again
    await hook(d, d.gateway.ref(1));
    expect(d.gateway.statusCalls).toBe(1);

    // later: the provider is asked, the decision finds the payment already in front of the team and changes nothing
    await patch(d, only(d).id, { providerCheckedAt: new Date(Date.now() - MINUTE) });
    await hook(d, d.gateway.ref(1));
    expect(d.gateway.statusCalls).toBe(2);

    expect(only(d).status).toBe('AWAITING_CONFIRMATION');
    expect(told(d, 'notifyPaymentToCheck')).toBe(1);
    expect(eventsOf(d, 'STATUS_CHANGED').filter((event) => event.title === 'Paiement à vérifier').length).toBe(1);
  });

  it('the team looks at it and confirms: it is counted once', async () => {
    const d = desk();

    await put(d, { amount: 100 });
    await d.payments.confirm(only(d).id, d.admin.id, {} as any);
    await hook(d, d.gateway.ref(1));

    expect(only(d).status).toBe('PAID');
    expect(only(d).confirmedById).toBe(d.admin.id);
    expect(eventsOf(d, 'PAYMENT_CONFIRMED').length).toBe(1);
  });

  it('paid after the request was cancelled (the customer was quick): it waits for a person, who decides', async () => {
    const d = desk();

    await ask(d);

    const id = only(d).id;

    await d.payments.cancel(id, d.admin.id, { reason: 'Annulé' } as any);
    expect(only(d).status).toBe('CANCELLED');

    d.gateway.settle(d.gateway.ref(1), 'PAID');
    await hook(d, d.gateway.ref(1));

    const payment = only(d);

    expect(payment.status).toBe('AWAITING_CONFIRMATION');
    // The reason of the late money first, and what the team wrote when it cancelled under it (it is not erased).
    expect(payment.adminNote).toBe(`${CARD_WORDS.late}\nAnnulé : Annulé`);
    expect(payment.cancelledAt).toBeNull();
    expect(payment.cancelReason).toBeNull();
    expect(told(d, 'notifyPaymentToCheck')).toBe(1);
  });

  it('paid after the payment was marked as failed by hand: the same', async () => {
    const d = desk();

    await ask(d);
    await d.payments.fail(only(d).id, d.admin.id, { reason: 'Échec' } as any);
    d.gateway.settle(d.gateway.ref(1), 'PAID');
    await hook(d, d.gateway.ref(1));

    expect(only(d).status).toBe('AWAITING_CONFIRMATION');
    expect(only(d).adminNote).toBe(`${CARD_WORDS.other}\nÉchoué : Échec`);
  });

  it('paid, but the job asks for less by then (nothing is left to take): it waits for a person, to be given back', async () => {
    const d = desk();

    await ask(d);
    await d.world.prisma.quote.update({ where: { id: d.quote.id }, data: { amountHT: 50, amountTTC: 50 } });
    d.gateway.settle(d.gateway.ref(1), 'PAID');
    await hook(d, d.gateway.ref(1));

    const payment = only(d);

    expect(payment.status).toBe('AWAITING_CONFIRMATION');
    expect(payment.adminNote).toBe(CARD_WORDS.over);
    expect(jobStatus(d)).toBe('PAYMENT_PENDING');
  });

  it('paid, and the payment had already been put in front of the team: the call does not confirm it by itself', async () => {
    const d = desk();

    await put(d, { amount: 100 });
    d.gateway.settle(d.gateway.ref(1), 'PAID', { amount: 119 });
    await hook(d, d.gateway.ref(1));

    expect(only(d).status).toBe('AWAITING_CONFIRMATION');
  });
});

describe('the team and the customer check a card payment (P2-10)', () => {
  it('a card payment that waits at the provider is not confirmed by a click; the check is what moves it', async () => {
    const d = desk();

    await ask(d);

    const problem = await refusal(() => d.payments.confirm(only(d).id, d.admin.id, {} as any));

    expect(problem).toEqual({ status: 409, message: CARD_WORDS.waitsAtProvider });
    expect(only(d).status).toBe('PENDING');
  });

  it('a card request nobody took can still be confirmed by hand, as before', async () => {
    const d = desk({ connected: false });

    await ask(d);
    await d.payments.confirm(only(d).id, d.admin.id, {} as any);

    expect(only(d).status).toBe('PAID');
  });

  it('the team can cancel it (and a late payment then goes to a person)', async () => {
    const d = desk();

    await ask(d);
    await d.payments.cancel(only(d).id, d.admin.id, {} as any);

    expect(only(d).status).toBe('CANCELLED');
  });

  it('the customer who comes back checks: the payment is confirmed and the answer is theirs to read', async () => {
    const d = desk();

    await ask(d);
    d.gateway.settle(d.gateway.ref(1), 'PAID');

    const answer: any = await d.payments.checkOnline(only(d).id, { id: d.client.id, role: 'CLIENT' as any });

    expect(answer.status).toBe('PAID');
    expect(answer).not.toHaveProperty('adminNote');
    expect(answer).not.toHaveProperty('providerPaymentId');
    expect(only(d).status).toBe('PAID');
  });

  it('somebody else\'s payment is not found; a payment with no provider has nothing to check', async () => {
    const d = desk();

    await ask(d);

    const id = only(d).id;

    expect((await refusal(() => d.payments.checkOnline(id, { id: d.stranger.id, role: 'CLIENT' as any })))?.status).toBe(404);
    expect((await refusal(() => d.payments.checkOnline(id, { id: d.artisan.id, role: 'ARTISAN' as any })))?.status).toBe(404);
    expect((await refusal(() => d.payments.checkOnline(9999, { id: d.admin.id, role: 'ADMIN' as any })))?.status).toBe(404);

    const cash = d.world.memory.plant('payment', { interventionId: d.job.id, method: 'CASH', provider: 'CASH', status: 'AWAITING_CONFIRMATION', amount: 5, currency: 'TND' });

    expect(await refusal(() => d.payments.checkOnline(cash.id, { id: d.admin.id, role: 'ADMIN' as any }))).toEqual({ status: 400, message: CARD_WORDS.nothingToCheck });
  });

  it('the team checks a payment whose webhook seems lost', async () => {
    const d = desk();

    await ask(d);
    d.gateway.settle(d.gateway.ref(1), 'PAID');

    const answer: any = await d.payments.checkOnline(only(d).id, { id: d.admin.id, role: 'ADMIN' as any });

    expect(answer.status).toBe('PAID');
    expect(answer.providerPaymentId).toBe(d.gateway.ref(1));
  });

  it('a provider that cannot be reached is a 503 for the person who asked', async () => {
    const d = desk();

    await ask(d);
    d.gateway.statusFails = new GatewayError('down', true);

    expect((await refusal(() => d.payments.checkOnline(only(d).id, { id: d.client.id, role: 'CLIENT' as any })))?.status).toBe(503);
  });

  it('from the tracking link: the payment is confirmed and the options are answered as they are then', async () => {
    const d = desk();

    await ask(d);
    d.gateway.settle(d.gateway.ref(1), 'PAID');

    const options: any = await d.guest.checkGuestPayment(d.job.id, LINK);

    expect(only(d).status).toBe('PAID');
    expect(options.received).toBe(119);
    expect(options.open).toBeNull();
    expect(options.canPay).toBe(false);
  });

  it('from the tracking link, a provider that cannot be reached is not an error: the page keeps asking', async () => {
    const d = desk();

    await ask(d);
    d.gateway.statusFails = new GatewayError('down', true);

    const options: any = await d.guest.checkGuestPayment(d.job.id, LINK);

    expect(options.open.status).toBe('PENDING');
  });

  it('the link of another job asks nothing of this job\'s payments', async () => {
    const d = desk();

    await ask(d);

    const problem = await refusal(() => d.guest.checkGuestPayment(d.job.id, 'a-link-that-is-not-this-one'));

    expect(problem?.status).toBe(404);
    expect(d.gateway.statusCalls).toBe(0);
  });

  it('a payment that was cancelled is asked about too: the customer may have paid in the last seconds', async () => {
    const d = desk();

    await ask(d);
    await d.payments.cancel(only(d).id, d.admin.id, {} as any);
    d.gateway.settle(d.gateway.ref(1), 'PAID');
    await d.guest.checkGuestPayment(d.job.id, LINK);

    expect(only(d).status).toBe('AWAITING_CONFIRMATION');
  });
});

describe('card payments that are not paid in time (P2-10)', () => {
  it('the time is over and the provider says it waits still: the payment is cancelled, once, after one last look', async () => {
    const d = desk();

    await ask(d);
    await lapse(d, only(d).id, 10);

    const done = await d.payments.sweepOnline();

    expect(done).toEqual({ looked: 1, confirmed: 0, expired: 1, unreachable: 0, dropped: 0 });

    const payment = only(d);

    expect(payment.status).toBe('CANCELLED');
    expect(payment.cancelReason).toBe(CARD_WORDS.expired);
    expect(payment.payUrl).toBeNull();
    expect(eventsOf(d, 'CANCELLED').length).toBe(1);
    expect(d.gateway.statusCalls).toBe(1);

    // nothing left to look at
    expect((await d.payments.sweepOnline()).looked).toBe(0);
    expect(eventsOf(d, 'CANCELLED').length).toBe(1);
  });

  it('the time is over, but the customer paid in the last seconds: it is confirmed, not cancelled', async () => {
    const d = desk();

    await ask(d);
    await lapse(d, only(d).id, 10);
    d.gateway.settle(d.gateway.ref(1), 'PAID');

    const done = await d.payments.sweepOnline();

    expect(done.confirmed).toBe(1);
    expect(done.expired).toBe(0);
    expect(only(d).status).toBe('PAID');
    expect(told(d, 'notifyPaymentReceived')).toBe(1);
  });

  it('a webhook that never came is made up for: a payment the provider says is paid is confirmed by the timer', async () => {
    const d = desk();

    await ask(d);
    d.gateway.settle(d.gateway.ref(1), 'PAID');

    expect((await d.payments.sweepOnline()).confirmed).toBe(1);
    expect(only(d).status).toBe('PAID');
  });

  it('the time is over, but within the grace: the payment is left as it is', async () => {
    const d = desk();

    await ask(d);
    await lapse(d, only(d).id, 2);

    const done = await d.payments.sweepOnline();

    expect(done.expired).toBe(0);
    expect(only(d).status).toBe('PENDING');
  });

  it('a payment that was looked at a moment ago is not looked at again', async () => {
    const d = desk();

    await ask(d);
    await d.payments.sweepOnline();
    await d.payments.sweepOnline();

    expect(d.gateway.statusCalls).toBe(1);

    await patch(d, only(d).id, { providerCheckedAt: new Date(Date.now() - 2 * MINUTE) });
    await d.payments.sweepOnline();

    expect(d.gateway.statusCalls).toBe(2);
  });

  it('a provider that cannot be reached: the payment is left for the next round; after a day it is cancelled anyway', async () => {
    const d = desk();

    await ask(d);
    await lapse(d, only(d).id, 10);
    d.gateway.statusFails = new GatewayError('down', true);

    const first = await d.payments.sweepOnline();

    expect(first.unreachable).toBe(1);
    expect(first.expired).toBe(0);
    expect(only(d).status).toBe('PENDING');
    // it is put behind the others for the next rounds, not asked again at once
    expect(only(d).providerCheckedAt).not.toBeNull();
    expect((await d.payments.sweepOnline()).unreachable).toBe(0);

    await lapse(d, only(d).id, 25 * 60);

    const later = await d.payments.sweepOnline(new Date(Date.now() + 2 * MINUTE));

    expect(later.expired).toBe(1);
    expect(only(d).status).toBe('CANCELLED');

    expect(only(d).cancelReason).toBe(CARD_WORDS.gaveUp);

    // the provider is back and says it was paid after all: the timer still looks at a payment it gave up on (once an hour), and a person decides
    d.gateway.statusFails = null;
    d.gateway.settle(d.gateway.ref(1), 'PAID');
    await d.payments.sweepOnline(new Date(Date.now() + 30 * MINUTE));
    expect(only(d).status).toBe('CANCELLED');

    await d.payments.sweepOnline(new Date(Date.now() + 3 * 60 * MINUTE));
    expect(only(d).status).toBe('AWAITING_CONFIRMATION');
    expect(only(d).moneySeenAt).not.toBeNull();
  });

  it('a payment given up on is asked about for a week, once an hour; one closed for another reason is only asked about for an hour after its time', async () => {
    const d = desk();

    await ask(d);

    const row = only(d);
    const ago = (days: number) => new Date(Date.now() - days * 24 * 60 * MINUTE);
    const close = (reason: string, closedDaysAgo: number, expiredDaysAgo = closedDaysAgo) =>
      patch(d, row.id, { status: 'CANCELLED', cancelReason: reason, payUrl: null, expiresAt: ago(expiredDaysAgo), cancelledAt: ago(closedDaysAgo), providerCheckedAt: null });

    await close(CARD_WORDS.gaveUp, 3);
    await d.payments.sweepOnline();
    expect(d.gateway.statusCalls).toBe(1);

    // asked less than an hour ago: not again
    await d.payments.sweepOnline(new Date(Date.now() + 20 * MINUTE));
    expect(d.gateway.statusCalls).toBe(1);

    // a week after it was given up it is left alone
    await close(CARD_WORDS.gaveUp, 8);
    await d.payments.sweepOnline();
    expect(d.gateway.statusCalls).toBe(1);

    // the week counts from the day it was given up on (a day or more after its time), not from its time
    await close(CARD_WORDS.gaveUp, 2, 9);
    await d.payments.sweepOnline();
    expect(d.gateway.statusCalls).toBe(2);

    // closed for another reason, a day after its time: left alone as well
    await close(CARD_WORDS.expired, 1);
    await d.payments.sweepOnline();
    expect(d.gateway.statusCalls).toBe(2);
  });

  it('a customer whose payment was given up on, and who asks for a card payment again, is not asked to pay twice: the first payment is looked at first and put in front of the team', async () => {
    const d = desk();

    await ask(d);
    await lapse(d, only(d).id, 10);
    d.gateway.statusFails = new GatewayError('down', true);
    await d.payments.sweepOnline();
    await lapse(d, only(d).id, 25 * 60);
    await d.payments.sweepOnline(new Date(Date.now() + 2 * MINUTE));
    expect(only(d).cancelReason).toBe(CARD_WORDS.gaveUp);

    // the customer had paid before the provider went quiet; the provider is back, and the customer comes back to pay
    d.gateway.statusFails = null;
    d.gateway.settle(d.gateway.ref(1), 'PAID');

    const again: any = await ask(d);

    expect(only(d).status).toBe('AWAITING_CONFIRMATION');
    expect(again.payment.id).toBe(only(d).id);
    expect(again.payment.payUrl ?? null).toBeNull();
    expect(d.gateway.created.length).toBe(1);
    expect(told(d, 'notifyPaymentToCheck')).toBe(1);

    // and the page "check my payment" asks about it too
    const other = desk();

    await ask(other);
    await patch(other, only(other).id, { status: 'CANCELLED', cancelReason: CARD_WORDS.gaveUp, cancelledAt: new Date(Date.now() - 3 * 24 * 60 * MINUTE), expiresAt: new Date(Date.now() - 4 * 24 * 60 * MINUTE) });
    expect((await other.payments.cardPaymentsToAsk(other.job.id)).length).toBe(1);
    await patch(other, only(other).id, { cancelledAt: new Date(Date.now() - 8 * 24 * 60 * MINUTE) });
    expect((await other.payments.cardPaymentsToAsk(other.job.id)).length).toBe(0);
  });

  it('the provider says the time is over, or the payment failed: the timer closes it the same way as a webhook', async () => {
    const d = desk();

    await ask(d);
    d.gateway.settle(d.gateway.ref(1), 'EXPIRED');

    expect((await d.payments.sweepOnline()).expired).toBe(1);
    expect(only(d).status).toBe('CANCELLED');
  });

  it('a request that never reached the provider and was not asked again is cancelled after a quarter of an hour; a recent one, or one being started, is not', async () => {
    const d = desk();
    const make = (data: Record<string, unknown>) => d.world.memory.plant('payment', { interventionId: d.job.id, method: 'ONLINE_CARD', provider: 'MANUAL', status: 'PENDING', amount: 119, currency: 'TND', createdById: d.job.clientId, ...data });
    const old = make({ requestedAt: new Date(Date.now() - 20 * MINUTE) });
    const fresh = make({ requestedAt: new Date(Date.now() - 5 * MINUTE) });
    const starting = make({ requestedAt: new Date(Date.now() - 20 * MINUTE), gatewayClaimedAt: new Date() });
    const done = await d.payments.sweepOnline();
    const status = (id: number) => rowsOf(d).find((row) => row.id === id)!.status;

    expect(done.dropped).toBe(1);
    expect(status(old.id)).toBe('CANCELLED');
    expect(rowsOf(d).find((row) => row.id === old.id)!.cancelReason).toBe(CARD_WORDS.notStarted);
    expect(status(fresh.id)).toBe('PENDING');
    expect(status(starting.id)).toBe('PENDING');
  });

  it('a request asked through the link of the request (nobody signed in behind it) that never reached the provider is dropped as well; one the back office recorded is not', async () => {
    const d = desk();

    // the provider is down when the customer asks through the link: the request is recorded with nobody behind it and no maker
    d.gateway.createFails = new GatewayError('down', true);
    await refusal(() => ask(d));
    d.gateway.createFails = null;

    expect(rowsOf(d).length).toBe(1);
    expect(rowsOf(d)[0].createdById ?? null).toBeNull();

    await patch(d, rowsOf(d)[0].id, { requestedAt: new Date(Date.now() - 20 * MINUTE) });

    const byHand = d.world.memory.plant('payment', { interventionId: d.job.id, method: 'ONLINE_CARD', provider: 'MANUAL', status: 'PENDING', amount: 5, currency: 'TND', createdById: d.admin.id, requestedAt: new Date(Date.now() - 20 * MINUTE) });

    expect((await d.payments.sweepOnline()).dropped).toBe(1);
    expect(rowsOf(d).find((row) => row.id !== byHand.id)!.status).toBe('CANCELLED');
    expect(rowsOf(d).find((row) => row.id === byHand.id)!.status).toBe('PENDING');
  });

  it('only card requests are dropped, and only while they are PENDING', async () => {
    const d = desk();
    const old = new Date(Date.now() - 20 * MINUTE);

    d.world.memory.plant('payment', { interventionId: d.job.id, method: 'CASH', provider: 'CASH', status: 'PENDING', amount: 5, currency: 'TND', requestedAt: old });
    d.world.memory.plant('payment', { interventionId: d.job.id, method: 'ONLINE_CARD', provider: 'MANUAL', status: 'AWAITING_CONFIRMATION', amount: 5, currency: 'TND', requestedAt: old });

    expect((await d.payments.sweepOnline()).dropped).toBe(0);
  });

  it('without a provider the timer does nothing, even to a request that waits forever', async () => {
    const d = desk({ connected: false });

    await ask(d);
    await patch(d, only(d).id, { requestedAt: new Date(Date.now() - 600 * MINUTE) });

    expect(await d.payments.sweepOnline()).toEqual({ looked: 0, confirmed: 0, expired: 0, unreachable: 0, dropped: 0 });
    expect(only(d).status).toBe('PENDING');
  });

  it('a round looks at fifty payments, and the rest are for the next', async () => {
    const d = desk();

    for (let index = 0; index < 60; index += 1) {
      d.world.memory.plant('payment', { interventionId: d.job.id, method: 'ONLINE_CARD', provider: 'KONNECT', status: 'PENDING', amount: 5, currency: 'TND', providerPaymentId: `bulk-${index}`, expiresAt: new Date(Date.now() - 10 * MINUTE) });
      d.gateway.kept.set(`bulk-${index}`, { state: 'PENDING', amount: 5, currency: 'TND', orderId: null });
    }

    const first = await d.payments.sweepOnline();
    const second = await d.payments.sweepOnline();

    expect(first.expired).toBe(50);
    expect(second.expired).toBe(10);
    expect(rowsOf(d).filter((row) => row.status === 'CANCELLED').length).toBe(60);
  });
});

describe('the timer service (P2-10)', () => {
  const service = (env: Record<string, string>, sweep: () => Promise<any>) => {
    const calls = { count: 0, purges: 0 };
    const payments: any = {
      sweepOnline: async () => {
        calls.count += 1;

        return sweep();
      },
      purgeWebhookLog: async () => {
        calls.purges += 1;

        return 0;
      },
    };

    return { timer: new PaymentExpiryService(payments, new PaymentGatewayService(readGatewayConfig(env))), calls };
  };
  const nothing = { looked: 0, confirmed: 0, expired: 0, unreachable: 0, dropped: 0 };

  it('runs a round when a provider is set up', async () => {
    const { timer, calls } = service(ENV, async () => nothing);

    await timer.tick();

    expect(calls.count).toBe(1);
  });

  it('does nothing without a provider, or when turned off', async () => {
    const none = service({}, async () => nothing);
    const off = service({ ...ENV, PAYMENT_EXPIRY_WORKER: 'off' }, async () => nothing);

    await none.timer.tick();
    await off.timer.tick();

    expect(none.calls.count).toBe(0);
    expect(off.calls.count).toBe(0);
  });

  it('a round that is still running is not started a second time', async () => {
    let release: () => void = () => undefined;
    let slow = true;
    const { timer, calls } = service(ENV, () => (slow ? new Promise((resolve) => (release = () => resolve(nothing))) : Promise.resolve(nothing)));
    const first = timer.tick();

    await timer.tick();
    expect(calls.count).toBe(1);

    slow = false;
    release();
    await first;
    await timer.tick();

    expect(calls.count).toBe(2);
  });

  it('the old calls of the provider are forgotten once an hour, not at every round', async () => {
    const { timer, calls } = service(ENV, async () => nothing);
    const realNow = Date.now;
    let at = realNow.call(Date);

    Date.now = () => at;

    try {
      await timer.tick();
      await timer.tick();
      at += 59 * MINUTE;
      await timer.tick();

      expect(calls.count).toBe(3);
      expect(calls.purges).toBe(1);

      at += 2 * MINUTE;
      await timer.tick();

      expect(calls.purges).toBe(2);
    } finally {
      Date.now = realNow;
    }
  });

  it('a purge that fails does not stop the timer, and is not tried again at once', async () => {
    const calls = { purges: 0, sweeps: 0 };
    const payments: any = {
      sweepOnline: async () => {
        calls.sweeps += 1;

        return nothing;
      },
      purgeWebhookLog: async () => {
        calls.purges += 1;

        throw new Error('the table is locked');
      },
    };
    const timer = new PaymentExpiryService(payments, new PaymentGatewayService(readGatewayConfig(ENV)));

    await timer.tick();
    await timer.tick();

    expect(calls.purges).toBe(1);
    // the round of that minute was not lost with the purge
    expect(calls.sweeps).toBe(2);
  });

  it('a round that fails does not stop the next', async () => {
    let fail = true;
    const { timer, calls } = service(ENV, async () => {
      if (fail) throw new Error('boom');

      return nothing;
    });

    await timer.tick();
    fail = false;
    await timer.tick();

    expect(calls.count).toBe(2);
  });
});

describe('idempotency keys (P2-10)', () => {
  it('the same key is the same payment, even after it was cancelled: no second payment is made', async () => {
    const d = desk();
    const first: any = await ask(d, 'CASH', 'key-1');

    await d.payments.cancel(first.payment.id, d.admin.id, {} as any);

    const second: any = await ask(d, 'CASH', 'key-1');

    expect(second.payment.id).toBe(first.payment.id);
    expect(second.payment.status).toBe('CANCELLED');
    expect(second.replayed).toBe(true);
    expect(rowsOf(d).length).toBe(1);
  });

  it('a key that is not sent is no key: two requests after a cancel make two payments', async () => {
    const d = desk();
    const first: any = await ask(d, 'CASH');

    await d.payments.cancel(first.payment.id, d.admin.id, {} as any);

    const second: any = await ask(d, 'CASH');

    expect(second.payment.id).not.toBe(first.payment.id);
    expect(rowsOf(d).length).toBe(2);
    expect(rowsOf(d).every((row) => row.idempotencyKey === null)).toBe(true);
  });

  it('the same key for another way of paying is refused (409), and nothing is made', async () => {
    const d = desk();

    await ask(d, 'CASH', 'key-1');

    const problem = await refusal(() => ask(d, 'BANK_TRANSFER', 'key-1'));

    expect(problem?.status).toBe(409);
    expect(problem?.message).toContain('clé d’idempotence');
    expect(rowsOf(d).length).toBe(1);
  });

  it('a signed-in customer: the same key is the same payment; another amount under the same key is refused', async () => {
    const d = desk();
    const first: any = await d.payments.createClientPaymentRequest(d.client.id, d.job.id, { method: 'CASH', amount: 50 } as any, 'key-1');
    const again: any = await d.payments.createClientPaymentRequest(d.client.id, d.job.id, { method: 'CASH', amount: 50 } as any, 'key-1');
    const other = await refusal(() => d.payments.createClientPaymentRequest(d.client.id, d.job.id, { method: 'CASH', amount: 60 } as any, 'key-1'));

    expect(again.id).toBe(first.id);
    expect(again.replayed).toBe(true);
    expect(other?.status).toBe(409);
    expect(rowsOf(d).length).toBe(1);
  });

  it('a key is the payer\'s own: the same words from the link and from the account are two keys', async () => {
    const d = desk();
    const fromLink: any = await ask(d, 'CASH', 'same-words');

    await d.payments.cancel(fromLink.payment.id, d.admin.id, {} as any);

    const fromAccount: any = await askAsClient(d, 'CASH', 'same-words');

    expect(fromAccount.id).not.toBe(fromLink.payment.id);
    expect(rowsOf(d).map((row) => row.idempotencyKey).sort()).toEqual([`c${d.client.id}:same-words`, `g${d.job.id}:same-words`].sort());
  });

  it('a card request under a key: a retry after the provider did not answer starts the same payment', async () => {
    const d = desk();

    d.gateway.createFails = new GatewayError('down', true);
    await refusal(() => ask(d, 'ONLINE_CARD', 'card-1'));
    d.gateway.createFails = null;

    const answer: any = await ask(d, 'ONLINE_CARD', 'card-1');

    expect(rowsOf(d).length).toBe(1);
    expect(answer.payment.payUrl).toContain('fake-ref-1');
    expect(answer.replayed).toBe(true);
  });

  it('a key that is empty is none; a key that is too long or has odd characters is refused (400)', async () => {
    const d = desk();

    await ask(d, 'CASH', '   ');
    expect(rowsOf(d)[0].idempotencyKey).toBeNull();

    for (const bad of ['x'.repeat(101), 'has space', 'semi;colon', '../up', 'é']) {
      const problem = await refusal(() => ask(d, 'CASH', bad));

      expect(problem?.status).toBe(400);
    }

    expect(rowsOf(d).length).toBe(1);
  });

  describe('refunds', () => {
    const paid = (d: Desk) => d.world.memory.plant('payment', { interventionId: d.job.id, method: 'CASH', provider: 'CASH', status: 'PAID', amount: 100, amountRefunded: 0, currency: 'TND', confirmedAt: new Date() });
    const refunds = (d: Desk) => d.world.memory.rows('paymentRefund');

    it('every refund is a row of its own, with the key it came with', async () => {
      const d = desk();
      const payment = paid(d);

      await d.payments.refund(payment.id, d.admin.id, { amount: 40, reason: 'Geste' } as any, 'refund-1');
      await d.payments.refund(payment.id, d.admin.id, { amount: 10 } as any);

      expect(refunds(d).map((row) => [Number(String(row.amount)), row.idempotencyKey, row.createdById])).toEqual([
        [40, `r${payment.id}:refund-1`, d.admin.id],
        [10, null, d.admin.id],
      ]);
      expect(Number(String(rowsOf(d)[0].amountRefunded))).toBe(50);
    });

    it('the same key is the same refund: the money goes back once, whatever the number of clicks', async () => {
      const d = desk();
      const payment = paid(d);

      await d.payments.refund(payment.id, d.admin.id, { amount: 40 } as any, 'refund-1');
      await d.payments.refund(payment.id, d.admin.id, { amount: 40 } as any, 'refund-1');
      await d.payments.refund(payment.id, d.admin.id, { amount: 40 } as any, 'refund-1');

      expect(Number(String(rowsOf(d)[0].amountRefunded))).toBe(40);
      expect(refunds(d).length).toBe(1);
      expect(told(d, 'notifyPaymentRefunded')).toBe(1);
      expect(eventsOf(d, 'STATUS_CHANGED').filter((event) => event.title === 'Remboursement partiel enregistré').length).toBe(1);
    });

    it('the same key at the same moment: once', async () => {
      const d = desk();
      const payment = paid(d);

      await Promise.all([1, 2, 3].map(() => d.payments.refund(payment.id, d.admin.id, { amount: 40 } as any, 'refund-1')));

      expect(Number(String(rowsOf(d)[0].amountRefunded))).toBe(40);
      expect(refunds(d).length).toBe(1);
    });

    it('the same key with no amount (the whole payment) is answered after the whole payment went back, not refused as "already refunded"', async () => {
      const d = desk();
      const payment = paid(d);

      const first: any = await d.payments.refund(payment.id, d.admin.id, {} as any, 'refund-all');
      const again: any = await d.payments.refund(payment.id, d.admin.id, {} as any, 'refund-all');

      expect(first.status).toBe('REFUNDED');
      expect(again.status).toBe('REFUNDED');
      // the answer says that it is the first refund again, so that the screen does not say that money went back a second time
      expect(first.replayed).toBeUndefined();
      expect(again.replayed).toBe(true);
      expect(refunds(d).length).toBe(1);

      // without a key the same click is refused, as before
      expect((await refusal(() => d.payments.refund(payment.id, d.admin.id, {} as any)))?.status).toBe(400);
    });

    it('the same key for another amount is refused (409) and nothing goes back', async () => {
      const d = desk();
      const payment = paid(d);

      await d.payments.refund(payment.id, d.admin.id, { amount: 40 } as any, 'refund-1');

      const problem = await refusal(() => d.payments.refund(payment.id, d.admin.id, { amount: 41 } as any, 'refund-1'));

      expect(problem?.status).toBe(409);
      expect(Number(String(rowsOf(d)[0].amountRefunded))).toBe(40);
    });

    it('another key is another refund; a key of one payment does not meet the same words on another', async () => {
      const d = desk();
      const first = paid(d);
      const second = paid(d);

      await d.payments.refund(first.id, d.admin.id, { amount: 10 } as any, 'refund-1');
      await d.payments.refund(first.id, d.admin.id, { amount: 10 } as any, 'refund-2');
      await d.payments.refund(second.id, d.admin.id, { amount: 10 } as any, 'refund-1');

      expect(refunds(d).length).toBe(3);
      expect(Number(String(rowsOf(d).find((row) => row.id === first.id)!.amountRefunded))).toBe(20);
      expect(Number(String(rowsOf(d).find((row) => row.id === second.id)!.amountRefunded))).toBe(10);
    });

    it('a bad key is refused before anything goes back', async () => {
      const d = desk();
      const payment = paid(d);

      expect((await refusal(() => d.payments.refund(payment.id, d.admin.id, { amount: 10 } as any, 'has space')))?.status).toBe(400);
      expect(refunds(d).length).toBe(0);
    });
  });
});

describe('a decision is taken from what is found under the lock, not from what the caller read (P2-10)', () => {
  const apply = (d: Desk, payment: any, verified: any) => (d.payments as any).applyProviderState(payment, verified);

  it('a caller that read the payment before another one confirmed it is answered "already": nothing is counted twice', async () => {
    const d = desk();

    await ask(d);

    const ref = d.gateway.ref(1);
    const stale = { ...only(d) };

    d.gateway.settle(ref, 'PAID');
    await hook(d, ref);

    const answer = await apply(d, stale, await d.gateway.status(ref));

    expect(answer.outcome).toBe('ALREADY');
    expect(only(d).status).toBe('PAID');
    expect(eventsOf(d, 'PAYMENT_CONFIRMED').length).toBe(1);
    expect(told(d, 'notifyPaymentReceived')).toBe(1);
    expect(d.world.memory.rows('interventionFinancials').length).toBe(1);
  });

  it('an answer about another number than the payment\'s own decides nothing', async () => {
    const d = desk();

    await ask(d);

    const ref = d.gateway.ref(1);

    d.gateway.settle(ref, 'PAID');

    const verified = { ...(await d.gateway.status(ref)), providerPaymentId: 'someone-elses-ref' };
    const answer = await apply(d, only(d), verified);

    expect(answer.outcome).toBe('UNKNOWN');
    expect(only(d).status).toBe('PENDING');
  });

  it('the provider says "failed" or "expired" about a payment that no longer waits: nothing changes, and the log says so', async () => {
    for (const state of ['FAILED', 'EXPIRED'] as const) {
      const d = desk();

      await ask(d);
      await d.payments.cancel(only(d).id, d.admin.id, {} as any);
      d.gateway.settle(d.gateway.ref(1), state);
      await hook(d, d.gateway.ref(1));

      expect(only(d).status).toBe('CANCELLED');
      expect(logOf(d)).toEqual(['UNCHANGED']);
    }
  });

  it('a payment of another provider, or one that is not a card payment, is never asked about', async () => {
    const d = desk();
    const other = d.world.memory.plant('payment', { interventionId: d.job.id, method: 'ONLINE', provider: 'PAYMEE', status: 'PENDING', amount: 5, currency: 'TND', providerPaymentId: 'fake-ref-1' });
    const cash = d.world.memory.plant('payment', { interventionId: d.job.id, method: 'CASH', provider: 'KONNECT', status: 'PENDING', amount: 5, currency: 'TND', providerPaymentId: 'fake-ref-1' });

    expect((await d.payments.syncFromProvider(other.id)).outcome).toBe('UNKNOWN');
    expect((await d.payments.syncFromProvider(cash.id)).outcome).toBe('UNKNOWN');
    expect(d.gateway.statusCalls).toBe(0);
  });

  it('a request that the timer cancels is not cancelled over a payment that was decided meanwhile', async () => {
    const d = desk();

    await ask(d);

    const ref = d.gateway.ref(1);
    const stale = { ...only(d) };

    d.gateway.settle(ref, 'PAID');
    await hook(d, ref);

    expect(await (d.payments as any).cancelOnline(stale, 'too late')).toBe(false);
    expect(only(d).status).toBe('PAID');
    expect(eventsOf(d, 'CANCELLED').length).toBe(0);
  });
});

describe('the edges of the webhook and of the timer (P2-10)', () => {
  it('a line of the log that cannot be written does not fail the call, and the payment is still counted', async () => {
    const d = desk();

    await ask(d);
    d.gateway.settle(d.gateway.ref(1), 'PAID');
    (d.world.prisma as any).paymentWebhookLog.create = async () => {
      throw new Error('the log table is down');
    };

    expect(await hook(d, d.gateway.ref(1))).toEqual({ received: true });
    expect(only(d).status).toBe('PAID');
  });

  it('a failure that is not the provider being down is not told to the provider as "try again later"', async () => {
    const d = desk();

    await ask(d);
    (d.gateway as any).status = async () => {
      throw new Error('a bug of ours');
    };

    const problem = await refusal(() => hook(d, d.gateway.ref(1)));

    expect(problem?.status).toBe(500);
    expect(problem?.message).toBe('a bug of ours');
    expect(logOf(d)).toEqual([]);
  });

  it('a payment is asked about again only once a minute has passed since the last look', async () => {
    const d = desk();

    await ask(d);

    const id = only(d).id;
    const now = Date.now();

    await patch(d, id, { providerCheckedAt: new Date(now - 30_000) });
    await d.payments.sweepOnline(new Date(now));

    expect(d.gateway.statusCalls).toBe(0);

    await patch(d, id, { providerCheckedAt: new Date(now - 61_000) });
    await d.payments.sweepOnline(new Date(now));

    expect(d.gateway.statusCalls).toBe(1);
  });

  it('a payment with no time to pay is left to the provider: the clock does not cancel it', async () => {
    const d = desk();

    await ask(d);
    await patch(d, only(d).id, { expiresAt: null });
    await d.payments.sweepOnline(new Date(Date.now() + 5 * 3_600_000));

    expect(only(d).status).toBe('PENDING');
  });

  it('a failure of ours on one payment is not hidden, and does not stop the others: it is logged, and the payment goes behind the rest', async () => {
    const d = desk();
    const errors: string[] = [];

    (d.payments as any).logger = { error: (message: string) => errors.push(message), warn: () => undefined, log: () => undefined };
    await ask(d);

    const bad = only(d);
    const second = d.world.memory.plant('payment', { interventionId: d.job.id, method: 'ONLINE_CARD', provider: 'KONNECT', status: 'PENDING', amount: 5, currency: 'TND', providerPaymentId: 'good-1', expiresAt: new Date(Date.now() + 10 * MINUTE) });
    const original = d.gateway.status.bind(d.gateway);

    d.gateway.kept.set('good-1', { state: 'PENDING', amount: 5, currency: 'TND', orderId: null });
    (d.gateway as any).status = async (ref: string) => {
      if (ref === bad.providerPaymentId) throw new Error('a bug of ours');

      return original(ref);
    };

    const done = await d.payments.sweepOnline();

    expect(done.unreachable).toBe(1);
    expect(done.looked).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`${bad.id}`);
    expect(errors[0]).toContain('Error');
    expect(errors[0]).not.toContain('a bug of ours');
    expect(rowsOf(d).find((row) => row.id === bad.id)!.providerCheckedAt).not.toBeNull();
    expect(rowsOf(d).find((row) => row.id === second.id)!.providerCheckedAt).not.toBeNull();
  });

  it('the payments asked about the longest ago are looked at first: one that keeps failing does not stand in front of the others every round', async () => {
    const d = desk();
    const plant = (name: string, checked: Date | null) => {
      d.gateway.kept.set(name, { state: 'PENDING', amount: 5, currency: 'TND', orderId: null });

      return d.world.memory.plant('payment', { interventionId: d.job.id, method: 'ONLINE_CARD', provider: 'KONNECT', status: 'PENDING', amount: 5, currency: 'TND', providerPaymentId: name, providerCheckedAt: checked, expiresAt: new Date(Date.now() + 30 * MINUTE) });
    };
    const asked: string[] = [];
    const original = d.gateway.status.bind(d.gateway);

    plant('a-recent', new Date(Date.now() - 2 * MINUTE));
    plant('b-never', null);
    plant('c-older', new Date(Date.now() - 10 * MINUTE));
    (d.gateway as any).status = async (ref: string) => {
      asked.push(ref);

      return original(ref);
    };

    await d.payments.sweepOnline();

    expect(asked).toEqual(['b-never', 'c-older', 'a-recent']);
  });

  it('a request the back office recorded by hand (online, but money to count) is never dropped as a request nobody took', async () => {
    const d = desk();
    const make = (data: Record<string, unknown>) => d.world.memory.plant('payment', { interventionId: d.job.id, method: 'ONLINE_CARD', provider: 'MANUAL', status: 'PENDING', amount: 119, currency: 'TND', requestedAt: new Date(Date.now() - 600 * MINUTE), ...data });
    const byHand = make({ createdById: d.job.clientId + 100 });
    const byTheCustomer = make({ createdById: d.job.clientId });

    expect((await d.payments.sweepOnline()).dropped).toBe(1);
    expect(rowsOf(d).find((row) => row.id === byHand.id)!.status).toBe('PENDING');
    expect(rowsOf(d).find((row) => row.id === byTheCustomer.id)!.status).toBe('CANCELLED');
  });
});

describe('starting a card payment, in detail (P2-10)', () => {
  /** A card request the provider did not take (it was down): a request with nobody behind it. */
  const placeholder = async (d: Desk) => {
    d.gateway.createFails = new GatewayError('down', true);
    await refusal(() => ask(d));
    d.gateway.createFails = null;

    return only(d);
  };

  it('a payment that is not a card payment is never sent to the provider', async () => {
    const d = desk();
    const cash = d.world.memory.plant('payment', { interventionId: d.job.id, method: 'CASH', provider: 'CASH', status: 'PENDING', amount: 5, currency: 'TND' });

    await startOnlinePayment(d.world.prisma, d.service, cash);

    expect(d.gateway.created.length).toBe(0);
  });

  it('an asker that waits for the first one stops waiting when the payment is decided meanwhile', async () => {
    const d = desk();
    const row = await placeholder(d);

    await patch(d, row.id, { gatewayClaimedAt: new Date() });

    let waits = 0;
    const answer = await startOnlinePayment(d.world.prisma, d.service, only(d), {
      wait: async () => {
        waits += 1;
        await patch(d, row.id, { status: 'CANCELLED' });
      },
      waitMs: 5000,
    });

    expect(answer.status).toBe('CANCELLED');
    expect(waits).toBe(1);
    expect(d.gateway.created.length).toBe(0);
  });

  it('a failure that is not the provider\'s is not told as "the provider is down", and the claim is let go', async () => {
    const d = desk();

    (d.gateway as any).create = async () => {
      throw new Error('a bug of ours');
    };

    const problem = await refusal(() => ask(d));

    expect(problem?.status).toBe(500);
    expect(problem?.message).toBe('a bug of ours');
    expect(only(d).gatewayClaimedAt).toBeNull();
  });

  it('a request that was cancelled while the provider was being asked keeps no provider payment, and the customer is sent nowhere', async () => {
    const d = desk();
    const create = d.gateway.create.bind(d.gateway);

    d.gateway.create = async (input) => {
      const created = await create(input);

      await patch(d, only(d).id, { status: 'CANCELLED' });

      return created;
    };

    // The customer is not told to pay a payment that no longer exists: they are asked to try again.
    await expect(ask(d)).rejects.toThrow(CARD_WORDS.changed);

    expect(only(d).status).toBe('CANCELLED');
    expect(only(d).providerPaymentId).toBeNull();
    expect(only(d).payUrl ?? null).toBeNull();
  });

  it('the time to pay is the one the environment says, to the provider and on the payment', async () => {
    const d = desk({ env: { PAYMENT_LIFESPAN_MINUTES: '45' } });

    await ask(d);

    const left = new Date(only(d).expiresAt).getTime() - Date.now();

    expect(d.gateway.created[0].lifespanMinutes).toBe(45);
    expect(left).toBeGreaterThan(44 * MINUTE);
    expect(left).toBeLessThanOrEqual(45 * MINUTE);
  });

  it('the name of the customer is given to the provider when the caller has it', async () => {
    const d = desk();
    const row = await placeholder(d);

    await startOnlinePayment(d.world.prisma, d.service, row, { customerName: 'Sami Ben Ali' });

    expect(d.gateway.created[0].customer).toEqual({ name: 'Sami Ben Ali' });
  });
});

describe('the tracking link and a card payment, in detail (P2-10)', () => {
  it('a payment that was marked as failed is asked about too: the customer may have paid', async () => {
    const d = desk();

    await ask(d);
    await d.payments.fail(only(d).id, d.admin.id, { reason: 'Pas reçu' } as any);
    d.gateway.settle(d.gateway.ref(1), 'PAID');
    await d.guest.checkGuestPayment(d.job.id, LINK);

    expect(only(d).status).toBe('AWAITING_CONFIRMATION');
  });

  it('the link of another job asks nothing about the payments of this one', async () => {
    const d = desk();

    await ask(d);

    const other = d.world.memory.plant('intervention', { clientId: d.client.id, artisanId: d.artisan.id, status: 'COMPLETED', serviceType: 'PLOMBIER', trackingToken: hashOf('link-of-the-other-job') });

    d.world.memory.plant('quote', { interventionId: other.id, createdById: d.artisan.id, status: 'ACCEPTED', amountHT: 80, taxAmount: 0, amountTTC: 80 });

    await d.guest.checkGuestPayment(other.id, 'link-of-the-other-job');

    expect(d.gateway.statusCalls).toBe(0);
    expect(only(d).status).toBe('PENDING');
  });

  it('the options that come back from a check know that a provider is connected', async () => {
    const d = desk();

    await ask(d);
    d.gateway.settle(d.gateway.ref(1), 'FAILED');

    const options: any = await d.guest.checkGuestPayment(d.job.id, LINK);

    expect(options.methods.find((choice: any) => choice.method === 'ONLINE_CARD')).toEqual({ method: 'ONLINE_CARD', available: true, reason: null });
  });
});

describe('idempotency keys on the signed-in customer\'s requests and on the refunds, in detail (P2-10)', () => {
  const paid = (d: Desk) => d.world.memory.plant('payment', { interventionId: d.job.id, method: 'CASH', provider: 'CASH', status: 'PAID', amount: 100, amountRefunded: 0, currency: 'TND', confirmedAt: new Date() });
  const refunds = (d: Desk) => d.world.memory.rows('paymentRefund');

  it('a signed-in customer: the same key is the same payment even after it was cancelled', async () => {
    const d = desk();
    const first: any = await askAsClient(d, 'CASH', 'key-9');

    await d.payments.cancel(first.id, d.admin.id, {} as any);

    const second: any = await askAsClient(d, 'CASH', 'key-9');

    expect(second.id).toBe(first.id);
    expect(second.status).toBe('CANCELLED');
    expect(second.replayed).toBe(true);
    expect(rowsOf(d).length).toBe(1);
  });

  it('a signed-in customer: the same key for another way of paying, or another amount, is refused with the sentence about keys', async () => {
    const d = desk();

    await d.payments.createClientPaymentRequest(d.client.id, d.job.id, { method: 'CASH', amount: 50 } as any, 'key-1');

    const way = await refusal(() => askAsClient(d, 'BANK_TRANSFER', 'key-1'));
    const amount = await refusal(() => d.payments.createClientPaymentRequest(d.client.id, d.job.id, { method: 'CASH', amount: 60 } as any, 'key-1'));

    for (const problem of [way, amount]) {
      expect(problem?.status).toBe(409);
      expect(problem?.message).toContain('clé d’idempotence');
    }

    expect(rowsOf(d).length).toBe(1);
  });

  it('a key that was kept for a payment of another job is not the answer to a request on this one (customer, and the link)', async () => {
    const d = desk();

    d.world.memory.plant('payment', { interventionId: d.job.id + 99, method: 'CASH', provider: 'CASH', status: 'PENDING', amount: 5, currency: 'TND', idempotencyKey: `c${d.client.id}:k1` });
    d.world.memory.plant('payment', { interventionId: d.job.id + 99, method: 'CASH', provider: 'CASH', status: 'PENDING', amount: 5, currency: 'TND', idempotencyKey: `g${d.job.id}:k1` });

    const customer = await refusal(() => askAsClient(d, 'CASH', 'k1'));
    const link = await refusal(() => ask(d, 'CASH', 'k1'));

    for (const problem of [customer, link]) {
      expect(problem?.status).toBe(409);
      expect(problem?.message).toContain('clé d’idempotence');
    }

    expect(rowsOf(d).length).toBe(2);
  });

  it('a refund key that was kept for another payment is not the answer to a refund of this one', async () => {
    const d = desk();
    const payment = paid(d);
    const other = paid(d);

    d.world.memory.plant('paymentRefund', { paymentId: other.id, amount: 10, reason: 'x', idempotencyKey: `r${payment.id}:k1`, createdById: d.admin.id });

    const problem = await refusal(() => d.payments.refund(payment.id, d.admin.id, { amount: 10 } as any, 'k1'));

    expect(problem?.status).toBe(409);
    expect(Number(String(rowsOf(d).find((row) => row.id === payment.id)!.amountRefunded))).toBe(0);
  });

  it('a key that arrives while the first refund is being written is answered under the lock, and nobody is told twice', async () => {
    const d = desk();
    const payment = paid(d);

    await d.payments.refund(payment.id, d.admin.id, { amount: 40 } as any, 'refund-1');

    // The look before the transaction misses (the first call had not written yet); the one under the lock finds the refund.
    const service = d.payments as any;
    const lookup = service.refundOfKey.bind(service);
    let missed = false;

    service.refundOfKey = async (db: any, ...rest: any[]) => {
      if (!missed && db === d.world.prisma) {
        missed = true;

        return false;
      }

      return lookup(db, ...rest);
    };

    const again: any = await d.payments.refund(payment.id, d.admin.id, { amount: 40 } as any, 'refund-1');

    expect(missed).toBe(true);
    expect(again.id).toBe(payment.id);
    expect(again.replayed).toBe(true);
    expect(Number(String(rowsOf(d).find((row) => row.id === payment.id)!.amountRefunded))).toBe(40);
    expect(refunds(d).length).toBe(1);
    expect(told(d, 'notifyPaymentRefunded')).toBe(1);
    expect(eventsOf(d, 'STATUS_CHANGED').filter((event) => event.title === 'Remboursement partiel enregistré').length).toBe(1);
  });

  it('the key is read as the server keeps it: a header sent twice counts once (the first), spaces are trimmed, and a key is of the payer', () => {
    expect(readIdempotencyKey(['abc', 'def'], 'c1')).toBe('c1:abc');
    expect(readIdempotencyKey('  abc ', 'c1')).toBe('c1:abc');
    expect(readIdempotencyKey('abc', 'c1')).not.toBe(readIdempotencyKey('abc', 'c2'));
    expect(readIdempotencyKey(undefined, 'c1')).toBeUndefined();
    expect(readIdempotencyKey(null, 'c1')).toBeUndefined();
    expect(readIdempotencyKey('   ', 'c1')).toBeUndefined();
    expect(readIdempotencyKey(42, 'c1')).toBeUndefined();
    expect(() => readIdempotencyKey('a b', 'c1')).toThrow();
    expect(() => readIdempotencyKey('x'.repeat(101), 'c1')).toThrow();
    expect(readIdempotencyKey('x'.repeat(100), 'c1')).toBe(`c1:${'x'.repeat(100)}`);
    expect(readIdempotencyKey('a.b_c:d-E9', 'c1')).toBe('c1:a.b_c:d-E9');
  });
});

describe('what the customer reads of a card payment (P2-10)', () => {
  const row = (data: Record<string, unknown>) => ({ id: 1, interventionId: 1, method: 'ONLINE_CARD', provider: 'KONNECT', status: 'PENDING', amount: 10, currency: 'TND', providerPaymentId: 'abc', payUrl: 'https://pay.example.test/x', expiresAt: new Date(0), adminNote: 'note', ...data });

  it('the page to pay on and the time are given while the payment waits, and only then', () => {
    expect(paymentForClient(row({})).payUrl).toBe('https://pay.example.test/x');
    expect(paymentForClient(row({})).expiresAt).toEqual(new Date(0));

    // the keys are always there (the shape is the same in every state), and empty when there is nothing to give
    for (const status of ['PAID', 'FAILED', 'CANCELLED', 'AWAITING_CONFIRMATION', 'REFUNDED']) {
      expect(paymentForClient(row({ status })).payUrl).toBeNull();
      expect(paymentForClient(row({ status })).expiresAt).toBeNull();
    }
  });

  it('a request nobody took has no page', () => {
    expect(paymentForClient(row({ providerPaymentId: null, payUrl: null })).payUrl).toBeNull();
    expect(paymentForClient(row({ providerPaymentId: null, payUrl: 'https://pay.example.test/x' })).payUrl).toBeNull();
  });

  it('the provider\'s number, the note of the team and the claim never reach the customer; the artisan reads none of it', () => {
    const view: any = paymentForClient(row({ gatewayClaimedAt: new Date(), providerCheckedAt: new Date(), idempotencyKey: 'c1:k' }));

    for (const key of ['providerPaymentId', 'adminNote', 'gatewayClaimedAt', 'providerCheckedAt', 'idempotencyKey']) expect(view).not.toHaveProperty(key);

    const artisan: any = paymentForArtisan(row({}));

    for (const key of ['payUrl', 'expiresAt', 'providerPaymentId', 'provider', 'method', 'adminNote']) expect(artisan).not.toHaveProperty(key);
  });
});

describe('the wiring of the webhook (P2-10)', () => {
  const read = (file: string) => fs.readFileSync(path.resolve(__dirname, file), 'utf8');

  it('is listed before the payments routes, so that /payments/webhooks/... is not read as /payments/:paymentId/...', () => {
    const text = read('payments.module.ts');

    expect(text.indexOf('PaymentWebhooksController')).toBeGreaterThan(-1);
    expect(text.indexOf('controllers: [PaymentWebhooksController, PaymentsController]')).toBeGreaterThan(-1);
  });

  it('is public (the provider has no account) and limited per address; the routes of the payments keep their guards', () => {
    const hooks = read('payment-webhooks.controller.ts');
    const payments = read('payments.controller.ts');

    expect(hooks).not.toContain('JwtAuthGuard');
    expect(hooks).not.toContain('@Roles');
    expect(hooks.match(/@UseGuards\(RateLimitGuard\)/g)?.length).toBe(2);
    expect(hooks).toContain("@Controller('payments/webhooks')");
    expect(payments).toContain('@UseGuards(JwtAuthGuard, RolesGuard)');
  });

  it('the timer is a provider of the module, and the gateway is exported for the tracking link', () => {
    const text = read('payments.module.ts');

    expect(text).toContain('PaymentExpiryService');
    expect(text).toMatch(/exports: \[PaymentsService, PaymentGatewayService\]/);
    expect(read('../guest/guest.module.ts')).toContain('PaymentsModule');
  });

  it('the three requests that repeat read the key from the Idempotency-Key header', () => {
    const header = "@Headers('idempotency-key') idempotencyKey?: string,";

    expect(read('payments.controller.ts').split(header).length - 1).toBe(2);
    expect(read('../guest/guest.controller.ts').split(header).length - 1).toBe(1);
    // the route of the customer's request, the one of the refund and the one of the visitor are the ones that carry it
    const parameters = (text: string, route: string) => {
      const from = text.indexOf(route);

      expect(from).toBeGreaterThan(-1);

      return text.slice(from, text.indexOf('\n  ) {', from));
    };

    expect(parameters(read('payments.controller.ts'), "@Post('interventions/:interventionId')")).toContain(header);
    expect(parameters(read('payments.controller.ts'), "@Patch(':paymentId/refund')")).toContain(header);
    expect(parameters(read('../guest/guest.controller.ts'), "@Post('interventions/:id/payments')")).toContain(header);
  });

  it('the controller hands the key (and the payment) on to the service', () => {
    const calls: any[] = [];
    const controller = new PaymentsController({
      refund: (...args: any[]) => calls.push(['refund', ...args]),
      createClientPaymentRequest: (...args: any[]) => calls.push(['create', ...args]),
      checkOnline: (...args: any[]) => calls.push(['check', ...args]),
    } as any);

    controller.refund(5, 7, { amount: 1 } as any, 'abc');
    controller.createClientPaymentRequest(7, 3, { method: 'CASH' } as any, 'xyz');
    controller.check({ id: 7, role: 'CLIENT' } as any, 4);

    expect(calls).toEqual([
      ['refund', 7, 5, { amount: 1 }, 'abc'],
      ['create', 7, 3, { method: 'CASH' }, 'xyz'],
      ['check', 4, { id: 7, role: 'CLIENT' }],
    ]);
  });

  it('the check of a card payment is open to the customer and to every role of the back office but the artisan', () => {
    const text = read('payments.controller.ts');
    const roles = /@Roles\(([^)]*)\)\s*@Post\(':paymentId\/check'\)/.exec(text);

    expect(roles).not.toBeNull();
    expect((roles![1].match(/Role\.(\w+)/g) ?? []).map((role) => role.slice(5)).sort()).toEqual(['ACCOUNTANT', 'ADMIN', 'CLIENT', 'DISPATCHER', 'SUPER_ADMIN', 'SUPPORT']);
  });

  it('the webhook is limited per address to 600 a minute, never cached, and answers 200 to a POST', () => {
    const text = read('payment-webhooks.controller.ts');

    expect(text.split("@RateLimit({ name: 'payment-webhook', limit: 600, windowMs: 60_000 })").length - 1).toBe(2);
    expect(text.split("@Header('Cache-Control', 'no-store')").length - 1).toBe(2);
    expect(text).toMatch(/@HttpCode\(200\)\s+@Post\(':provider'\)/);
    expect(text).toMatch(/@Get\(':provider'\)\s+receiveGet/);
  });

  it('lets the pages send the Idempotency-Key header: the server names no list of allowed headers, so the browser\'s own request is echoed', () => {
    const main = read('../../main.ts').replace(/\/\/.*$/gm, '');

    expect(main).toContain('app.enableCors({');
    expect(main).not.toContain('allowedHeaders');
  });
});

describe('what the first reading of the card payments changed (P2-10)', () => {
  const read = (file: string) => fs.readFileSync(path.resolve(__dirname, file), 'utf8');
  const MONEY = (d: Desk) => {
    const row = only(d);

    return { id: row.id, status: row.status, seen: row.moneySeenAt ?? null };
  };

  it('a request seen without a provider is cancelled only while it still has none: a page the provider gave meanwhile is not cancelled under the customer', async () => {
    const d = desk();

    await ask(d);

    const started = only(d);

    expect(await (d.payments as any).cancelOnline(started, CARD_WORDS.notStarted, { claimedBefore: new Date(Date.now() + MINUTE) })).toBe(false);
    expect(only(d).status).toBe('PENDING');
    expect(only(d).payUrl).not.toBeNull();

    // the same call without the condition is the expiry of a payment the provider knows: it goes through
    expect(await (d.payments as any).cancelOnline(started, CARD_WORDS.expired)).toBe(true);
    expect(only(d).status).toBe('CANCELLED');
  });

  it('a request being started at that moment (claimed since) is not cancelled either; one whose claim is old, or none, is', async () => {
    const d = desk();
    const make = (data: Record<string, unknown>) => d.world.memory.plant('payment', { interventionId: d.job.id, method: 'ONLINE_CARD', provider: 'MANUAL', status: 'PENDING', amount: 5, currency: 'TND', createdById: d.job.clientId, ...data });
    const claimedBefore = new Date(Date.now() - 15 * MINUTE);
    const busy = make({ gatewayClaimedAt: new Date() });
    const stale = make({ gatewayClaimedAt: new Date(Date.now() - 20 * MINUTE) });
    const never = make({});

    expect(await (d.payments as any).cancelOnline(busy, CARD_WORDS.notStarted, { claimedBefore })).toBe(false);
    expect(await (d.payments as any).cancelOnline(stale, CARD_WORDS.notStarted, { claimedBefore })).toBe(true);
    expect(await (d.payments as any).cancelOnline(never, CARD_WORDS.notStarted, { claimedBefore })).toBe(true);
    expect(rowsOf(d).find((row) => row.id === busy.id)!.status).toBe('PENDING');
  });

  it('a request replaced by another way of paying is cancelled only while no provider has it', async () => {
    const d = desk();

    await ask(d);

    expect(await supersede(d.world.prisma as any, only(d))).toBe(false);
    expect(only(d).status).toBe('PENDING');

    const none = d.world.memory.plant('payment', { interventionId: d.job.id, method: 'ONLINE_CARD', provider: 'MANUAL', status: 'PENDING', amount: 5, currency: 'TND' });

    expect(await supersede(d.world.prisma as any, none)).toBe(true);
    expect(rowsOf(d).find((row) => row.id === none.id)!.status).toBe('CANCELLED');
  });

  it('money that came on a payment the team then closed does not open it again when the provider says it again (no second notice either)', async () => {
    for (const close of ['fail', 'cancel'] as const) {
      const d = desk();

      await ask(d);
      d.gateway.settle(d.gateway.ref(1), 'EXPIRED');
      await hook(d, d.gateway.ref(1));
      expect(only(d).status).toBe('CANCELLED');

      // the customer paid after the end of the time: it goes to the team, once
      d.gateway.settle(d.gateway.ref(1), 'PAID');
      await hook(d, d.gateway.ref(1));
      expect(MONEY(d).status).toBe('AWAITING_CONFIRMATION');
      expect(MONEY(d).seen).not.toBeNull();
      expect(told(d, 'notifyPaymentToCheck')).toBe(1);

      // the team gives the money back at the provider and closes the payment
      await d.payments[close](only(d).id, d.admin.id, { reason: 'Remboursé chez le prestataire' } as any);
      expect(only(d).status).toBe(close === 'fail' ? 'FAILED' : 'CANCELLED');

      // the provider says it again (a second delivery, a check): nothing changes, nobody is told again
      await patch(d, only(d).id, { providerCheckedAt: new Date(Date.now() - MINUTE) });
      await hook(d, d.gateway.ref(1));
      await hook(d, d.gateway.ref(1));

      expect(only(d).status).toBe(close === 'fail' ? 'FAILED' : 'CANCELLED');
      expect(told(d, 'notifyPaymentToCheck')).toBe(1);
      expect(eventsOf(d, 'PAYMENT_PENDING').length + eventsOf(d, 'STATUS_CHANGED').length).toBeGreaterThan(0);
      // The second call says again what the first said: it is written once.
      expect(d.world.memory.rows('paymentWebhookLog').map((row) => row.outcome).slice(-2)).toEqual(['REVIEW', 'UNCHANGED']);
    }
  });

  it('a payment closed before any money came is still opened when money comes (nobody dealt with it)', async () => {
    const d = desk();

    await ask(d);
    await d.payments.cancel(only(d).id, d.admin.id, { reason: 'Demande de la cliente' } as any);

    expect(only(d).moneySeenAt ?? null).toBeNull();

    d.gateway.settle(d.gateway.ref(1), 'PAID');
    await hook(d, d.gateway.ref(1));

    expect(only(d).status).toBe('AWAITING_CONFIRMATION');
    expect(only(d).moneySeenAt).not.toBeNull();
  });

  it('a notice that cannot be written after the money was recorded does not turn the confirmation into an error', async () => {
    const d = desk();
    const errors: string[] = [];

    (d.payments as any).logger = { error: (message: string) => errors.push(message), warn: () => undefined, log: () => undefined };
    await ask(d);
    (d.payments as any).createEvent = async () => {
      throw new Error('the timeline is down');
    };
    d.gateway.settle(d.gateway.ref(1), 'PAID');

    expect(await hook(d, d.gateway.ref(1))).toEqual({ received: true });
    expect(only(d).status).toBe('PAID');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('CONFIRMED');
    expect(errors[0]).not.toContain('the timeline is down');
  });

  it('the calls of the provider older than three months are forgotten, the others kept', async () => {
    const d = desk();
    const row = (days: number) => d.world.memory.plant('paymentWebhookLog', { provider: 'KONNECT', providerPaymentId: `ref-${days}`, paymentId: null, outcome: 'ALREADY', receivedAt: new Date(Date.now() - days * 24 * 60 * MINUTE) });

    row(100);
    row(91);
    row(89);
    row(1);

    expect(await d.payments.purgeWebhookLog()).toBe(2);
    expect(d.world.memory.rows('paymentWebhookLog').map((entry) => entry.providerPaymentId).sort()).toEqual(['ref-1', 'ref-89']);
  });

  it('a key found taken by the database at the last moment is the answer for a key used for another request, not a server error', async () => {
    const conflict: any = asKeyConflict({ code: 'P2002', meta: { target: ['idempotencyKey'] } });

    expect(conflict.getStatus()).toBe(409);
    expect(conflict.message).toBe(KEY_WORDS.used);

    const other = new Error('something else');

    expect(asKeyConflict(other)).toBe(other);
    expect(asKeyConflict({ code: 'P2003' })).toEqual({ code: 'P2003' });
    expect(asKeyConflict(null)).toBeNull();
    expect(asKeyConflict('text')).toBe('text');

    // both ways of asking for a payment turn the refusal of the database into it
    expect(read('payments.service.ts')).toContain('.catch((error: unknown) => {\n        throw asKeyConflict(error);');
    expect(read('../guest/guest.service.ts')).toContain('.catch((error: unknown) => {\n          throw asKeyConflict(error);');
  });

  it('a reference of a transfer sent under the key of a request that carried none is refused, not answered as if it had been written (customer and link)', async () => {
    const d = desk();
    const first: any = await d.guest.createGuestPayment(d.job.id, LINK, { method: 'BANK_TRANSFER' } as any, 'k-1');

    expect(first.replayed ?? false).toBe(false);
    expect(only(d).reference ?? null).toBeNull();

    const refused = await refusal(() => d.guest.createGuestPayment(d.job.id, LINK, { method: 'BANK_TRANSFER', reference: 'VIR-123456' } as any, 'k-1'));

    expect(refused?.status).toBe(409);
    expect(refused?.message).toBe(KEY_WORDS.used);
    expect(only(d).reference ?? null).toBeNull();

    // the same request again is still the same request
    const again: any = await d.guest.createGuestPayment(d.job.id, LINK, { method: 'BANK_TRANSFER' } as any, 'k-1');

    expect(again.payment.id).toBe(first.payment.id);

    // under a key of its own, the reference is written to the payment that waits
    await d.guest.createGuestPayment(d.job.id, LINK, { method: 'BANK_TRANSFER', reference: 'VIR-123456' } as any, 'k-2');

    expect(only(d).reference).toBe('VIR-123456');

    // a request that carried a reference, sent again with the same reference: the same request; with another one: refused
    const second = desk();

    await second.guest.createGuestPayment(second.job.id, LINK, { method: 'BANK_TRANSFER', reference: 'REF-A' } as any, 'k-3');

    expect((await second.guest.createGuestPayment(second.job.id, LINK, { method: 'BANK_TRANSFER', reference: 'REF-A' } as any, 'k-3') as any).payment.reference).toBe('REF-A');
    expect((await refusal(() => second.guest.createGuestPayment(second.job.id, LINK, { method: 'BANK_TRANSFER', reference: 'REF-B' } as any, 'k-3')))?.status).toBe(409);
    expect(only(second).reference).toBe('REF-A');

    // the customer who is signed in: the same rules
    const signed = desk();

    await askAsClient(signed, 'BANK_TRANSFER', 'k-4');

    expect((await refusal(() => signed.payments.createClientPaymentRequest(signed.client.id, signed.job.id, { method: 'BANK_TRANSFER', reference: 'VIR-9' } as any, 'k-4')))?.status).toBe(409);
    expect(only(signed).reference ?? null).toBeNull();
    expect((await signed.payments.createClientPaymentRequest(signed.client.id, signed.job.id, { method: 'BANK_TRANSFER', reference: 'VIR-9' } as any, 'k-5') as any).id).toBeDefined();
    expect(only(signed).reference).toBe('VIR-9');

    // the same reference sent again under the key it came with is the same request, answered with the payment it made
    const sameSigned = desk();
    const madeFirst: any = await sameSigned.payments.createClientPaymentRequest(sameSigned.client.id, sameSigned.job.id, { method: 'BANK_TRANSFER', reference: 'VIR-10' } as any, 'k-6');
    const madeAgain: any = await sameSigned.payments.createClientPaymentRequest(sameSigned.client.id, sameSigned.job.id, { method: 'BANK_TRANSFER', reference: 'VIR-10' } as any, 'k-6');

    expect(madeAgain.id).toBe(madeFirst.id);
    expect(madeAgain.replayed).toBe(true);
    expect(rowsOf(sameSigned).length).toBe(1);
  });

  it('a look that fails stamps only a payment that still waits: one decided meanwhile is left as it is', async () => {
    const d = desk();

    await ask(d);

    const id = only(d).id;

    (d.gateway as any).status = async () => {
      await patch(d, id, { status: 'PAID' });

      throw new GatewayError('down', true);
    };

    expect((await d.payments.sweepOnline()).unreachable).toBe(1);
    expect(only(d).status).toBe('PAID');
    expect(only(d).providerCheckedAt ?? null).toBeNull();
  });

  it('the check of a card payment by a signed-in person is limited per address (each call asks the provider)', () => {
    const text = read('payments.controller.ts');

    expect(text).toMatch(/@UseGuards\(RateLimitGuard\)\s+@RateLimit\(\{ name: 'payment-check', limit: 360, windowMs: 60 \* 60_000 \}\)\s+@Roles\(([^)]*)\)\s+@Post\(':paymentId\/check'\)/);
  });

  it('the columns only the back office reads are in the list that no other reader gets, whatever route they come through', () => {
    const list = read('../../common/interceptors/strip-staff-fields.ts');

    for (const key of ['idempotencyKey', 'gatewayClaimedAt', 'providerCheckedAt', 'moneySeenAt', 'providerPaymentId', 'adminNote']) expect(list).toContain(`'${key}'`);
  });
});

describe('what the second reading of the card payments changed (P2-10)', () => {
  const read = (file: string) => fs.readFileSync(path.resolve(__dirname, file), 'utf8');
  const byTheTeam = (d: Desk, data: Record<string, unknown> = {}) =>
    d.world.memory.plant('payment', { interventionId: d.job.id, method: 'ONLINE_CARD', provider: 'MANUAL', status: 'PENDING', amount: 119, currency: 'TND', createdById: d.admin.id, ...data });
  const admin = (d: Desk) => ({ id: d.admin.id, role: 'ADMIN' as any });

  describe('an online payment the team entered by hand', () => {
    it('is neither taken over nor cancelled by a customer who asks to pay by card (the link, or the account): the request is refused', async () => {
      for (const method of ['ONLINE_CARD', 'ONLINE']) {
        for (const via of ['link', 'account'] as const) {
          const d = desk();
          const held = byTheTeam(d, { method: method === 'ONLINE' ? 'ONLINE_CARD' : 'ONLINE' });
          const refused = await refusal(() => (via === 'link' ? ask(d, method) : askAsClient(d, method)));

          expect(refused?.status).toBe(409);
          expect(refused?.message).toContain('est déjà en attente');
          expect(d.gateway.created.length).toBe(0);
          expect(rowsOf(d).length).toBe(1);
          expect(rowsOf(d)[0].id).toBe(held.id);
          expect(rowsOf(d)[0].status).toBe('PENDING');
          expect(rowsOf(d)[0].providerPaymentId ?? null).toBeNull();
          expect(rowsOf(d)[0].provider).toBe('MANUAL');
        }
      }
    });

    it('the team asking for the same online payment twice gets the same payment back (it is the team\'s own, and nothing is started at the provider)', async () => {
      const d = desk();
      const first: any = await d.payments.createAdminManualPayment(d.admin.id, d.job.id, { method: 'ONLINE_CARD' } as any);
      const second: any = await d.payments.createAdminManualPayment(d.admin.id, d.job.id, { method: 'ONLINE_CARD' } as any);

      expect(second.id).toBe(first.id);
      expect(rowsOf(d).length).toBe(1);
      expect(rowsOf(d)[0].status).toBe('PENDING');
      expect(d.gateway.created.length).toBe(0);
    });

    it('the team asking for another way of paying clears its own empty online request, as it always did', async () => {
      const d = desk();

      await d.payments.createAdminManualPayment(d.admin.id, d.job.id, { method: 'ONLINE_CARD' } as any);
      await d.payments.createAdminManualPayment(d.admin.id, d.job.id, { method: 'CASH' } as any);

      expect(rowsOf(d).map((row) => [row.method, row.status])).toEqual([
        ['ONLINE_CARD', 'CANCELLED'],
        ['CASH', 'AWAITING_CONFIRMATION'],
      ]);
    });

    it('the same amount by the same way is not "the same request" for the customer: the row is not answered, it is not started at the provider', async () => {
      const d = desk();

      byTheTeam(d);

      expect((await refusal(() => ask(d, 'ONLINE_CARD')))?.status).toBe(409);
      expect((await refusal(() => askAsClient(d, 'ONLINE_CARD')))?.status).toBe(409);
      expect(d.gateway.created.length).toBe(0);
    });

    it('stands in the way of other ways of paying, and the options say so', async () => {
      const d = desk();

      byTheTeam(d);

      expect((await refusal(() => ask(d, 'BANK_TRANSFER')))?.status).toBe(409);

      const options: any = await d.guest.getPaymentOptions(d.job.id, LINK);

      expect(options.open).not.toBeNull();
      expect(options.methods.filter((method: any) => method.method === 'ONLINE_CARD' || method.method === 'BANK_TRANSFER').every((method: any) => method.available === false)).toBe(true);
    });

    it('the team confirms it by hand, as before', async () => {
      const d = desk();
      const held = byTheTeam(d);

      await d.payments.confirm(held.id, d.admin.id, {} as any);

      expect(rowsOf(d)[0].status).toBe('PAID');
    });

    it('while the customer\'s own empty request is still taken over by the same request, and replaced by another way of paying', async () => {
      const d = desk({ connected: false });
      const mine = await askAsClient(d, 'ONLINE_CARD');
      const again: any = await askAsClient(d, 'ONLINE_CARD');

      expect(again.id).toBe((mine as any).id);

      await askAsClient(d, 'BANK_TRANSFER');

      expect(rowsOf(d).map((row) => row.status).sort()).toEqual(['AWAITING_CONFIRMATION', 'CANCELLED']);
    });
  });

  describe('money that arrives where the system must not count it by itself', () => {
    it('card paid on a mission that was cancelled meanwhile: it waits for a person (a refund is due), the job stays cancelled', async () => {
      const d = desk();

      await ask(d);
      await d.world.prisma.intervention.update({ where: { id: d.job.id }, data: { status: 'CANCELLED' } });
      d.gateway.settle(d.gateway.ref(1), 'PAID');
      await hook(d, d.gateway.ref(1));

      expect(only(d).status).toBe('AWAITING_CONFIRMATION');
      expect(only(d).adminNote).toBe(CARD_WORDS.jobCancelled);
      expect(only(d).moneySeenAt).not.toBeNull();
      expect(jobStatus(d)).toBe('CANCELLED');
      expect(told(d, 'notifyPaymentToCheck')).toBe(1);
      expect(told(d, 'notifyPaymentReceived')).toBe(0);
    });

    it('a wrong amount is kept for the team, and stays on the payment when the team confirms it with a word of its own', async () => {
      const d = desk();

      await ask(d);
      d.gateway.settle(d.gateway.ref(1), 'PAID', { amount: 150 });
      await hook(d, d.gateway.ref(1));

      const reason = only(d).adminNote as string;

      expect(only(d).status).toBe('AWAITING_CONFIRMATION');
      expect(reason).toContain('au lieu de');
      expect(reason).toContain('150');

      await d.payments.confirm(only(d).id, d.admin.id, { adminNote: 'ok vu avec le client' } as any);

      expect(only(d).status).toBe('PAID');
      expect(only(d).adminNote).toBe(`ok vu avec le client\n${reason}`);

      // a confirmation with no word of the team's leaves the line as it is
      const e = desk();

      await ask(e);
      e.gateway.settle(e.gateway.ref(1), 'PAID', { amount: 150 });
      await hook(e, e.gateway.ref(1));
      await e.payments.confirm(only(e).id, e.admin.id, {} as any);

      expect(only(e).adminNote).toContain('150');
    });

    it('the note of the team on a payment is not erased when late money puts it in front of the team', async () => {
      const d = desk();

      await ask(d);
      await patch(d, only(d).id, { adminNote: 'À rappeler jeudi' });
      await d.payments.cancel(only(d).id, d.admin.id, { reason: 'Demande de la cliente' } as any);
      d.gateway.settle(d.gateway.ref(1), 'PAID');
      await hook(d, d.gateway.ref(1));

      const note = String(only(d).adminNote);

      expect(note.split('\n')[0]).toBe(CARD_WORDS.late);
      expect(note).toContain('Annulé : Demande de la cliente');
      expect(note).toContain('À rappeler jeudi');
    });

    it('a card payment that was refused or closed without any money is not confirmed by hand (the page may be paid later); one that held money is', async () => {
      const refused = desk();

      await ask(refused);
      refused.gateway.settle(refused.gateway.ref(1), 'FAILED');
      await hook(refused, refused.gateway.ref(1));
      expect(only(refused).status).toBe('FAILED');

      const answer = await refusal(() => refused.payments.confirm(only(refused).id, refused.admin.id, {} as any));

      expect(answer?.status).toBe(409);
      expect(answer?.message).toBe(CARD_WORDS.failedAtProvider);
      expect(only(refused).status).toBe('FAILED');

      const byHand = desk();

      await ask(byHand);
      await byHand.payments.fail(only(byHand).id, byHand.admin.id, { reason: 'Échec' } as any);
      expect((await refusal(() => byHand.payments.confirm(only(byHand).id, byHand.admin.id, {} as any)))?.message).toBe(CARD_WORDS.failedAtProvider);

      // money was seen: the team closed the payment, then changed its mind
      const seen = desk();

      await ask(seen);
      await seen.payments.cancel(only(seen).id, seen.admin.id, { reason: 'Test' } as any);
      seen.gateway.settle(seen.gateway.ref(1), 'PAID');
      await hook(seen, seen.gateway.ref(1));
      await seen.payments.fail(only(seen).id, seen.admin.id, { reason: 'Erreur' } as any);
      await seen.payments.confirm(only(seen).id, seen.admin.id, {} as any);

      expect(only(seen).status).toBe('PAID');
    });
  });

  describe('a card payment whose time is over', () => {
    it('is closed by the next request, after one last look at the provider; the customer gets a new page, not the dead one', async () => {
      for (const via of ['link', 'account'] as const) {
        const d = desk();
        const first: any = await (via === 'link' ? ask(d) : askAsClient(d));
        const firstId = (via === 'link' ? first.payment : first).id;

        // two minutes past its time: inside the minutes the timer waits before it cancels
        await lapse(d, firstId, 2);

        const before = d.gateway.statusCalls;
        const second: any = await (via === 'link' ? ask(d) : askAsClient(d));
        const next = via === 'link' ? second.payment : second;

        expect(d.gateway.statusCalls).toBe(before + 1);
        expect(next.id).not.toBe(firstId);
        expect(next.payUrl).toContain(d.gateway.ref(2));
        expect(rowsOf(d).find((row) => row.id === firstId)!.status).toBe('CANCELLED');
        expect(rowsOf(d).find((row) => row.id === firstId)!.cancelReason).toBe(CARD_WORDS.expired);
        expect(rowsOf(d).find((row) => row.id === next.id)!.status).toBe('PENDING');
      }
    });

    it('paid in the last seconds: the look confirms it, and the new request is told the job is paid', async () => {
      const d = desk();

      await ask(d);
      await lapse(d, only(d).id, 2);
      d.gateway.settle(d.gateway.ref(1), 'PAID');

      const answer = await refusal(() => ask(d));

      expect(answer?.status).toBe(400);
      expect(answer?.message).toBe(PAYMENT_WORDS_PAID);
      expect(only(d).status).toBe('PAID');
      expect(d.gateway.created.length).toBe(1);
    });

    it('a provider that cannot be reached leaves it as it is: a new card request is told to try again in a moment (not handed the old page), and the timer closes it later', async () => {
      const d = desk();
      const first: any = await ask(d);

      await lapse(d, first.payment.id, 2);
      d.gateway.statusFails = new GatewayError('down', true);

      expect((await refusal(() => ask(d)))?.status).toBe(503);
      expect((await refusal(() => askAsClient(d)))?.status).toBe(503);
      expect((await refusal(() => ask(d)))?.message).toBe(CARD_WORDS.checking);
      expect(only(d).status).toBe('PENDING');
      expect(d.gateway.created.length).toBe(1);

      // the provider is back: the old one is closed after one last look, and the new request gets a page of its own
      d.gateway.statusFails = null;

      const third: any = await ask(d);

      expect(third.payment.id).not.toBe(first.payment.id);
      expect(rowsOf(d).find((row) => row.id === first.payment.id)!.status).toBe('CANCELLED');
      expect(d.gateway.created.length).toBe(2);
    });

    it('a request that is not a card request is not refused because a lapsed card could not be looked at', async () => {
      const d = desk();
      const first: any = await ask(d);

      await lapse(d, first.payment.id, 2);
      d.gateway.statusFails = new GatewayError('down', true);

      // (the card payment still stands in the way of another way of paying, as before; what is told is that, not "unavailable")
      const problem = await refusal(() => askAsClient(d, 'CASH'));

      expect(problem?.status).not.toBe(503);
      expect(only(d).status).toBe('PENDING');
    });

    it('one that is still inside its time is not looked at, and a provider without a lapsed payment is not asked at all', async () => {
      const d = desk();

      await ask(d);

      const before = d.gateway.statusCalls;

      await ask(d);
      await askAsClient(d);

      expect(d.gateway.statusCalls).toBe(before);
      expect(rowsOf(d).length).toBe(1);

      // nothing is asked when no provider is connected
      const none = desk({ connected: false });

      await none.payments.closeLapsedCards(none.job.id);

      expect(none.gateway.statusCalls).toBe(0);
    });

    it('a provider that is set aside (its key is missing) is not asked about a lapsed card, and does not stand in the way of a request', async () => {
      const d = desk();

      await ask(d);
      await lapse(d, only(d).id, 5);

      const off = new PaymentsService(d.world.prisma, d.world.svc.events, d.world.svc.told, new PaymentGatewayService(readGatewayConfig({}), d.gateway));
      const before = d.gateway.statusCalls;

      await off.closeLapsedCards(d.job.id, new Date(), { required: true });

      expect(d.gateway.statusCalls).toBe(before);
      expect(only(d).status).toBe('PENDING');
    });
  });

  describe('the amount a signed-in customer types', () => {
    it('is not more than what is left to pay when the payment is by card (the provider would charge it)', async () => {
      const d = desk();
      const refused = await refusal(() => d.payments.createClientPaymentRequest(d.client.id, d.job.id, { method: 'ONLINE_CARD', amount: 5000 } as any));

      expect(refused?.status).toBe(400);
      expect(refused?.message).toContain('dépasse ce qu’il reste à payer');
      expect(refused?.message).toContain('119');
      expect(rowsOf(d).length).toBe(0);
      expect(d.gateway.created.length).toBe(0);

      const part: any = await d.payments.createClientPaymentRequest(d.client.id, d.job.id, { method: 'ONLINE_CARD', amount: 100 } as any);

      expect(Number(part.amount)).toBe(100);
      expect(d.gateway.created[0].amount).toBe(100);

      const whole = desk();
      const exact: any = await whole.payments.createClientPaymentRequest(whole.client.id, whole.job.id, { method: 'ONLINE_CARD', amount: 119 } as any);

      expect(Number(exact.amount)).toBe(119);
    });

    it('what is left counts what was already paid, and a job that is paid takes no card payment', async () => {
      const d = desk();

      d.world.memory.plant('payment', { interventionId: d.job.id, method: 'CASH', provider: 'CASH', status: 'PAID', amount: 100, currency: 'TND', createdById: d.admin.id, confirmedAt: new Date() });

      expect((await refusal(() => d.payments.createClientPaymentRequest(d.client.id, d.job.id, { method: 'ONLINE_CARD', amount: 50 } as any)))?.message).toContain('19');
      expect((await refusal(() => d.payments.createClientPaymentRequest(d.client.id, d.job.id, { method: 'ONLINE_CARD', amount: 19.5 } as any)))?.status).toBe(400);
      expect(Number(((await d.payments.createClientPaymentRequest(d.client.id, d.job.id, { method: 'ONLINE_CARD', amount: 19 } as any)) as any).amount)).toBe(19);
    });

    it('other ways of paying keep the rule they had (the confirmation checks the amount)', async () => {
      const d = desk();
      const transfer: any = await d.payments.createClientPaymentRequest(d.client.id, d.job.id, { method: 'BANK_TRANSFER', amount: 5000 } as any);

      expect(Number(transfer.amount)).toBe(5000);
    });
  });

  describe('keys', () => {
    it('the key of a request answered with the payment that was already open is kept on it: asked again after that payment was cancelled, it is the same request', async () => {
      for (const via of ['link', 'account'] as const) {
        const d = desk();
        const run = (key?: string) => (via === 'link' ? ask(d, 'ONLINE_CARD', key) : askAsClient(d, 'ONLINE_CARD', key));
        const first: any = await run();
        const firstId = (via === 'link' ? first.payment : first).id;

        expect(rowsOf(d)[0].idempotencyKey ?? null).toBeNull();

        const again: any = await run('retry-key');

        expect(again.replayed).toBe(true);
        expect(rowsOf(d)[0].idempotencyKey).toBe(via === 'link' ? `g${d.job.id}:retry-key` : `c${d.client.id}:retry-key`);

        await d.payments.cancel(firstId, d.admin.id, { reason: 'Test' } as any);

        const lost: any = await run('retry-key');

        expect((via === 'link' ? lost.payment : lost).id).toBe(firstId);
        expect(lost.replayed).toBe(true);
        expect(rowsOf(d).length).toBe(1);
      }
    });

    it('a payment that has a key keeps it: another key answered with it is not written on it', async () => {
      const d = desk();

      await ask(d, 'ONLINE_CARD', 'first-key');
      await ask(d, 'ONLINE_CARD', 'second-key');

      expect(rowsOf(d)[0].idempotencyKey).toBe(`g${d.job.id}:first-key`);
    });

    it('the invoice that was named is part of the request: the same key for another invoice is another request', () => {
      const d = desk();
      const keyed = (payment: any, request: any) => (d.payments as any).isSameKeyedRequest(payment, { interventionId: d.job.id, method: 'ONLINE_CARD', ...request });
      const payment = { interventionId: d.job.id, method: 'ONLINE_CARD', amount: 119, invoiceId: 7, reference: null };

      expect(keyed(payment, { invoiceId: 7 })).toBe(true);
      expect(keyed(payment, { invoiceId: 8 })).toBe(false);
      expect(keyed(payment, {})).toBe(true);
      expect(keyed({ ...payment, invoiceId: null }, { invoiceId: 7 })).toBe(false);
      expect(keyed({ ...payment, invoiceId: null }, {})).toBe(true);
    });

    it('two requests of one customer for two jobs with one key, at the same moment: one is made, the other is told the key is used (not a server error)', async () => {
      const d = desk();
      const second = d.world.memory.plant('intervention', { clientId: d.client.id, artisanId: d.artisan.id, status: 'COMPLETED', serviceType: 'PLOMBIER', trackingToken: hashOf('other-link') });

      d.world.memory.plant('quote', { interventionId: second.id, createdById: d.artisan.id, status: 'ACCEPTED', amountHT: 80, taxAmount: 0, amountTTC: 80 });

      const outcomes = await Promise.allSettled([
        d.payments.createClientPaymentRequest(d.client.id, d.job.id, { method: 'BANK_TRANSFER' } as any, 'shared-key'),
        d.payments.createClientPaymentRequest(d.client.id, second.id, { method: 'BANK_TRANSFER' } as any, 'shared-key'),
      ]);
      const failed = outcomes.filter((outcome) => outcome.status === 'rejected') as PromiseRejectedResult[];

      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled').length).toBe(1);
      expect(failed.length).toBe(1);
      expect(failed[0].reason.getStatus()).toBe(409);
      expect(failed[0].reason.message).toBe(KEY_WORDS.used);
      expect(rowsOf(d).length).toBe(1);
    });
  });

  describe('a request replaced while the provider was being asked', () => {
    it('the signed-in customer is told to try again, not sent to a cancelled payment', async () => {
      const d = desk();
      const create = d.gateway.create.bind(d.gateway);

      d.gateway.create = async (input) => {
        const created = await create(input);

        await patch(d, only(d).id, { status: 'CANCELLED' });

        return created;
      };

      const refused = await refusal(() => askAsClient(d));

      expect(refused?.status).toBe(409);
      expect(refused?.message).toBe(CARD_WORDS.changed);
    });
  });

  describe('the calls of the provider', () => {
    const backdate = (d: Desk, id: number, seconds: number) => patch(d, id, { providerCheckedAt: new Date(Date.now() - seconds * 1000) });

    it('a loop of calls naming one payment asks the provider once, and writes once', async () => {
      const d = desk();

      await ask(d);

      for (let call = 0; call < 25; call += 1) await hook(d, d.gateway.ref(1));

      expect(d.gateway.statusCalls).toBe(1);
      expect(logOf(d)).toEqual(['PENDING']);
    });

    it('a few seconds later the provider is asked again (the real call must not be lost for long)', async () => {
      const d = desk();

      await ask(d);
      await hook(d, d.gateway.ref(1));
      await backdate(d, only(d).id, 4);
      await hook(d, d.gateway.ref(1));

      expect(d.gateway.statusCalls).toBe(1);

      await backdate(d, only(d).id, 6);
      d.gateway.settle(d.gateway.ref(1), 'PAID');
      await hook(d, d.gateway.ref(1));

      expect(d.gateway.statusCalls).toBe(2);
      expect(only(d).status).toBe('PAID');
      expect(logOf(d)).toEqual(['PENDING', 'CONFIRMED']);
    });

    it('the customer who taps again at once gets the answer of the last look; the click of the team is always a new question', async () => {
      const d = desk();
      const customer = { id: d.client.id, role: 'CLIENT' as any };
      const team = { id: d.admin.id, role: 'ADMIN' as any };

      await ask(d);
      await d.payments.checkOnline(only(d).id, customer);
      expect(d.gateway.statusCalls).toBe(1);

      // five seconds have not passed: the look stands
      await d.payments.checkOnline(only(d).id, customer);
      expect(d.gateway.statusCalls).toBe(1);

      // the team asked for it: always an answer
      await d.payments.checkOnline(only(d).id, team);
      expect(d.gateway.statusCalls).toBe(2);

      await backdate(d, only(d).id, 6);
      await d.payments.checkOnline(only(d).id, customer);
      expect(d.gateway.statusCalls).toBe(3);
    });

    it('the page "check my payment" does not ask again about a payment asked about a few seconds ago, and asks once they have passed', async () => {
      const d = desk();

      await ask(d);
      await d.guest.checkGuestPayment(d.job.id, LINK);
      expect(d.gateway.statusCalls).toBe(1);

      await d.guest.checkGuestPayment(d.job.id, LINK);
      expect(d.gateway.statusCalls).toBe(1);

      await backdate(d, only(d).id, 6);
      await d.guest.checkGuestPayment(d.job.id, LINK);
      expect(d.gateway.statusCalls).toBe(2);
    });

    it('the first call of the provider is never held back, whatever the customer did before', async () => {
      const d = desk();

      await ask(d);
      d.gateway.settle(d.gateway.ref(1), 'PAID');
      await hook(d, d.gateway.ref(1));

      expect(only(d).status).toBe('PAID');
      expect(d.gateway.statusCalls).toBe(1);
    });

    it('a payment that is no longer waiting is not held back (and writes what changed once, then what repeats once in ten minutes)', async () => {
      const d = desk();

      await ask(d);
      d.gateway.settle(d.gateway.ref(1), 'PAID');
      await hook(d, d.gateway.ref(1));

      for (let call = 0; call < 10; call += 1) await hook(d, d.gateway.ref(1));

      // the money is already counted: no more questions to the provider, one line for the repeat
      expect(d.gateway.statusCalls).toBe(1);
      expect(logOf(d)).toEqual(['CONFIRMED', 'ALREADY']);

      // ten minutes later it is written again
      const old = d.world.memory.rows('paymentWebhookLog').find((row) => row.outcome === 'ALREADY')!;

      await d.world.prisma.paymentWebhookLog.update({ where: { id: old.id }, data: { receivedAt: new Date(Date.now() - 11 * MINUTE) } });
      await hook(d, d.gateway.ref(1));

      expect(logOf(d)).toEqual(['CONFIRMED', 'ALREADY', 'ALREADY']);
    });

    it('what the provider could not answer, and what changed, is always written', async () => {
      const d = desk();

      await ask(d);
      d.gateway.statusFails = new GatewayError('down', true);

      for (let call = 0; call < 3; call += 1) expect((await refusal(() => hook(d, d.gateway.ref(1))))?.status).toBe(503);

      // an unreachable provider stamps nothing: each call of the provider is answered with a retry request, and written once in ten minutes
      expect(logOf(d)).toEqual(['UNREACHABLE']);
    });

    it('whatever became of a payment, a loop of calls with its number asks the provider once in a few seconds: closed, held by the team for money, or closed after that', async () => {
      const d = desk();
      const ref = () => d.gateway.ref(1);
      const calls = () => d.gateway.statusCalls;
      const repeat = async (times = 5) => {
        for (let n = 0; n < times; n += 1) await hook(d, ref());
      };
      const aged = () => patch(d, only(d).id, { providerCheckedAt: new Date(Date.now() - MINUTE) });

      // closed by the team, nothing seen
      await ask(d);
      await d.payments.cancel(only(d).id, d.admin.id, { reason: 'Demande de la cliente' } as any);
      await repeat();
      expect(calls()).toBe(1);
      expect(only(d).providerCheckedAt).not.toBeNull();

      // money for another amount: in front of the team
      await aged();
      d.gateway.settle(ref(), 'PAID', { amount: 50 });
      await hook(d, ref());
      expect(only(d).status).toBe('AWAITING_CONFIRMATION');
      expect(calls()).toBe(2);
      await repeat();
      expect(calls()).toBe(2);

      // asked again later, and found as it was: the look is stamped, so the loop is held back once more
      await patch(d, only(d).id, { providerCheckedAt: new Date(Date.now() - MINUTE) });
      await hook(d, ref());
      expect(calls()).toBe(3);
      expect(Date.now() - new Date(only(d).providerCheckedAt).getTime()).toBeLessThan(5000);
      await repeat();
      expect(calls()).toBe(3);

      // closed by the team after that: the money was seen, and the same money seen again is stamped as well
      await d.payments.cancel(only(d).id, d.admin.id, { reason: 'Remboursé chez le prestataire' } as any);
      await aged();
      await hook(d, ref());
      expect(calls()).toBe(4);
      expect(Date.now() - new Date(only(d).providerCheckedAt).getTime()).toBeLessThan(5000);
      await repeat();
      expect(calls()).toBe(4);
      expect(only(d).status).toBe('CANCELLED');
    });

    it('a look the provider refuses (the key, an unknown payment) is a look all the same: the pause applies; one that failed for a passing reason is asked again at once', async () => {
      const d = desk();

      await ask(d);
      d.gateway.statusFails = new GatewayError('refused', false, 'REFUSED');

      for (let call = 0; call < 4; call += 1) expect((await refusal(() => hook(d, d.gateway.ref(1))))?.status).toBe(call === 0 ? 503 : undefined);
      expect(d.gateway.statusCalls).toBe(1);
      expect(only(d).providerCheckedAt).not.toBeNull();

      // the team's click is always a question
      await refusal(() => d.payments.checkOnline(only(d).id, d.admin));
      expect(d.gateway.statusCalls).toBe(2);

      // a passing failure stamps nothing: the provider's retry is answered
      const e = desk();

      await ask(e);
      e.gateway.statusFails = new GatewayError('down', true);
      for (let call = 0; call < 3; call += 1) expect((await refusal(() => hook(e, e.gateway.ref(1))))?.status).toBe(503);
      expect(e.gateway.statusCalls).toBe(3);
      expect(only(e).providerCheckedAt ?? null).toBeNull();
    });

    it('the customer\'s page "check my payment" is held back the same way after a refused look; a passing failure is asked again at once', async () => {
      const d = desk();

      await ask(d);
      d.gateway.statusFails = new GatewayError('refused', false, 'REFUSED');

      expect((await refusal(() => d.payments.checkOnline(only(d).id, d.client)))?.status).toBe(503);
      expect(d.gateway.statusCalls).toBe(1);
      expect(only(d).providerCheckedAt).not.toBeNull();

      for (let call = 0; call < 3; call += 1) expect(await refusal(() => d.payments.checkOnline(only(d).id, d.client))).toBeNull();

      expect(d.gateway.statusCalls).toBe(1);

      const e = desk();

      await ask(e);
      e.gateway.statusFails = new GatewayError('down', true);

      for (let call = 0; call < 3; call += 1) expect((await refusal(() => e.payments.checkOnline(only(e).id, e.client)))?.status).toBe(503);

      expect(e.gateway.statusCalls).toBe(3);
      expect(only(e).providerCheckedAt ?? null).toBeNull();
    });

    it('a number nobody was given is answered like a known one and writes nothing', async () => {
      const d = desk();

      await ask(d);
      expect(await hook(d, 'nobody-gave-this')).toEqual({ received: true });
      expect(logOf(d)).toEqual([]);
      expect(d.gateway.statusCalls).toBe(0);
    });
  });

  describe('a payment closed here is still watched for a while', () => {
    it('the customer pays on the page the provider keeps, after the team cancelled it, and no webhook comes: the round finds it and puts it in front of the team', async () => {
      const d = desk();

      await ask(d);
      await d.payments.cancel(only(d).id, d.admin.id, { reason: 'Demande de la cliente' } as any);
      d.gateway.settle(d.gateway.ref(1), 'PAID');

      const done = await d.payments.sweepOnline();

      expect(done.looked).toBe(1);
      expect(only(d).status).toBe('AWAITING_CONFIRMATION');
      expect(only(d).moneySeenAt).not.toBeNull();
      expect(String(only(d).adminNote).split('\n')[0]).toBe(CARD_WORDS.late);
      expect(told(d, 'notifyPaymentToCheck')).toBe(1);

      // and it is not looked at again
      const statusBefore = d.gateway.statusCalls;

      await d.payments.sweepOnline();
      expect(d.gateway.statusCalls).toBe(statusBefore);
    });

    it('the same for a payment the team marked as failed', async () => {
      const d = desk();

      await ask(d);
      await d.payments.fail(only(d).id, d.admin.id, { reason: 'Échec' } as any);
      d.gateway.settle(d.gateway.ref(1), 'PAID');
      await d.payments.sweepOnline();

      expect(only(d).status).toBe('AWAITING_CONFIRMATION');
      expect(told(d, 'notifyPaymentToCheck')).toBe(1);
    });

    it('a payment closed because its time was over is watched too (the customer may pay in the last minutes)', async () => {
      const d = desk();

      await ask(d);
      await lapse(d, only(d).id, 20);
      d.gateway.settle(d.gateway.ref(1), 'PENDING');
      expect((await d.payments.sweepOnline()).expired).toBe(1);
      expect(only(d).status).toBe('CANCELLED');

      await patch(d, only(d).id, { providerCheckedAt: new Date(Date.now() - 6 * MINUTE) });
      d.gateway.settle(d.gateway.ref(1), 'PAID');
      await d.payments.sweepOnline();

      expect(only(d).status).toBe('AWAITING_CONFIRMATION');
    });

    it('it is asked about at most every five minutes, and not any more an hour after its time', async () => {
      const d = desk();

      await ask(d);
      await d.payments.cancel(only(d).id, d.admin.id, { reason: 'Test' } as any);

      const calls = () => d.gateway.statusCalls;

      await d.payments.sweepOnline();
      expect(calls()).toBe(1);
      expect(only(d).providerCheckedAt).not.toBeNull();

      await d.payments.sweepOnline();
      expect(calls()).toBe(1);

      // four minutes is too soon, six is not
      await patch(d, only(d).id, { providerCheckedAt: new Date(Date.now() - 4 * MINUTE) });
      await d.payments.sweepOnline();
      expect(calls()).toBe(1);

      await patch(d, only(d).id, { providerCheckedAt: new Date(Date.now() - 6 * MINUTE) });
      await d.payments.sweepOnline();
      expect(calls()).toBe(2);

      // the time of the payment was an hour and a half ago
      await patch(d, only(d).id, { providerCheckedAt: new Date(Date.now() - 6 * MINUTE), expiresAt: new Date(Date.now() - 90 * MINUTE) });
      await d.payments.sweepOnline();
      expect(calls()).toBe(2);
    });

    it('the page "check my payment" asks about the request closed a moment ago and the new one, three payments at the most', async () => {
      const d = desk();

      for (let round = 0; round < 3; round += 1) {
        await ask(d);
        await d.payments.cancel(rowsOf(d)[rowsOf(d).length - 1].id, d.admin.id, { reason: 'Test' } as any);
      }

      await ask(d);

      const ids = rowsOf(d).map((row) => row.id);

      expect(ids.length).toBe(4);
      expect((await d.payments.cardPaymentsToAsk(d.job.id)).map((row) => row.id)).toEqual([ids[3], ids[2], ids[1]]);
    });

    it('a payment the team already holds because of money, or one that was never at the provider, is not asked about', async () => {
      const d = desk();

      await ask(d);
      await d.payments.cancel(only(d).id, d.admin.id, { reason: 'Test' } as any);
      await patch(d, only(d).id, { moneySeenAt: new Date() });

      const plain = d.world.memory.plant('payment', { interventionId: d.job.id, method: 'ONLINE_CARD', provider: 'MANUAL', status: 'CANCELLED', amount: 119, currency: 'TND', cancelledAt: new Date() });

      expect(plain.id).toBeGreaterThan(0);
      await d.payments.sweepOnline();
      expect(d.gateway.statusCalls).toBe(0);
    });

    it('a look that finds nothing to do stamps the payment, a look that fails does too, so that neither is asked every minute', async () => {
      const d = desk();

      await ask(d);
      await d.payments.cancel(only(d).id, d.admin.id, { reason: 'Test' } as any);
      d.gateway.statusFails = new GatewayError('down', true);
      expect((await d.payments.sweepOnline()).unreachable).toBe(1);
      expect(only(d).providerCheckedAt).not.toBeNull();
      expect(only(d).status).toBe('CANCELLED');

      d.gateway.statusFails = null;
      await patch(d, only(d).id, { providerCheckedAt: null });
      d.gateway.settle(d.gateway.ref(1), 'EXPIRED');
      await d.payments.sweepOnline();
      expect(only(d).status).toBe('CANCELLED');
      expect(only(d).providerCheckedAt).not.toBeNull();
    });

    it('the page "check my payment" asks about the ones that wait and the ones closed a short while ago, never the ones long closed, nor the ones the team holds', async () => {
      const d = desk();

      await ask(d);
      await d.payments.cancel(only(d).id, d.admin.id, { reason: 'Test' } as any);

      expect((await d.payments.cardPaymentsToAsk(d.job.id)).length).toBe(1);

      await patch(d, only(d).id, { expiresAt: new Date(Date.now() - 90 * MINUTE) });
      expect((await d.payments.cardPaymentsToAsk(d.job.id)).length).toBe(0);

      await patch(d, only(d).id, { expiresAt: new Date(Date.now() + 5 * MINUTE), status: 'AWAITING_CONFIRMATION' });
      expect((await d.payments.cardPaymentsToAsk(d.job.id)).length).toBe(0);

      await patch(d, only(d).id, { status: 'PENDING' });
      expect((await d.payments.cardPaymentsToAsk(d.job.id)).length).toBe(1);

      await patch(d, only(d).id, { status: 'CANCELLED', moneySeenAt: new Date() });
      expect((await d.payments.cardPaymentsToAsk(d.job.id)).length).toBe(0);
    });
  });

  describe('the sweep of requests nobody took', () => {
    it('a pile of the team\'s own old requests does not keep the customer\'s from being dropped', async () => {
      const d = desk();
      const make = (data: Record<string, unknown>) => d.world.memory.plant('payment', { interventionId: d.job.id, method: 'ONLINE_CARD', provider: 'MANUAL', status: 'PENDING', amount: 119, currency: 'TND', requestedAt: new Date(Date.now() - 600 * MINUTE), ...data });

      for (let n = 0; n < 60; n += 1) make({ createdById: d.admin.id });

      const mine = make({ createdById: d.client.id });

      // the first round looks at fifty of them and sets them aside; the next one reaches the customer's
      await d.payments.sweepOnline();
      expect(rowsOf(d).find((row) => row.id === mine.id)!.status).toBe('PENDING');
      expect(rowsOf(d).filter((row) => row.providerCheckedAt).length).toBe(50);

      await d.payments.sweepOnline();
      expect(rowsOf(d).find((row) => row.id === mine.id)!.status).toBe('CANCELLED');
      expect(rowsOf(d).filter((row) => row.status === 'PENDING').length).toBe(60);

      // and they are not looked at again
      const dropped = (await d.payments.sweepOnline()).dropped;

      expect(dropped).toBe(0);
      expect(rowsOf(d).filter((row) => row.providerCheckedAt).length).toBe(60);
    });

    it('a pile of requests being started, or of old requests already closed, does not keep a stale one from being dropped', async () => {
      const d = desk();
      const old = new Date(Date.now() - 600 * MINUTE);
      const make = (data: Record<string, unknown>) => d.world.memory.plant('payment', { interventionId: d.job.id, method: 'ONLINE_CARD', provider: 'MANUAL', status: 'PENDING', amount: 119, currency: 'TND', createdById: d.client.id, requestedAt: old, ...data });

      // sixty requests that are being started at this moment (claimed a second ago), and sixty that were closed long ago without a provider
      for (let n = 0; n < 60; n += 1) make({ gatewayClaimedAt: new Date() });
      for (let n = 0; n < 60; n += 1) make({ status: 'CANCELLED', cancelledAt: old });

      const stale = make({});

      expect((await d.payments.sweepOnline()).dropped).toBe(1);
      expect(rowsOf(d).find((row) => row.id === stale.id)!.status).toBe('CANCELLED');
      expect(rowsOf(d).filter((row) => row.status === 'PENDING').length).toBe(60);
    });
  });

  describe('a payment that is already started, or no longer waits', () => {
    it('is handed back as it is: nothing is written, nobody is waited for, and the provider is not asked', async () => {
      const d = desk();

      await ask(d);

      const started = only(d);
      const closed = d.world.memory.plant('payment', { interventionId: d.job.id, method: 'ONLINE_CARD', provider: 'MANUAL', status: 'CANCELLED', amount: 5, currency: 'TND' });
      const prisma: any = d.world.prisma;
      const original = prisma.payment.updateMany.bind(prisma.payment);
      const writes: unknown[] = [];
      let waits = 0;

      prisma.payment.updateMany = async (args: unknown) => {
        writes.push(args);

        return original(args);
      };

      try {
        const options = { wait: async () => void (waits += 1) };

        expect(await startOnlinePayment(prisma, d.service, started, options)).toBe(started);
        expect(await startOnlinePayment(prisma, d.service, closed, options)).toBe(closed);
      } finally {
        prisma.payment.updateMany = original;
      }

      expect(writes.length).toBe(0);
      expect(waits).toBe(0);
      expect(d.gateway.created.length).toBe(1);
    });

    it('keeps the first moment the money was seen when the provider says it again about a payment not yet decided', async () => {
      const d = desk();

      await ask(d);

      const first = new Date(Date.now() - 2 * 24 * 60 * MINUTE);

      await patch(d, only(d).id, { moneySeenAt: first });
      d.gateway.settle(d.gateway.ref(1), 'PAID', { amount: 1 });
      await d.payments.sweepOnline();

      expect(only(d).status).toBe('AWAITING_CONFIRMATION');
      expect(new Date(only(d).moneySeenAt).getTime()).toBe(first.getTime());
    });
  });

  describe('the check of the team', () => {
    it('is told when the provider was not asked (it is not the one connected here), instead of reading a verdict that never happened', async () => {
      const d = desk();

      await ask(d);
      await patch(d, only(d).id, { provider: 'PAYMEE' });

      const refused = await refusal(() => d.payments.checkOnline(only(d).id, admin(d)));

      expect(refused?.status).toBe(409);
      expect(refused?.message).toBe(CARD_WORDS.notAsked);
      expect(d.gateway.statusCalls).toBe(0);

      // the payment is untouched, and the one that is the provider's is checked as usual
      expect(only(d).status).toBe('PENDING');

      await patch(d, only(d).id, { provider: 'KONNECT' });
      expect((await refusal(() => d.payments.checkOnline(only(d).id, admin(d))))).toBeNull();
      expect(d.gateway.statusCalls).toBe(1);
    });
  });

  describe('the table of the calls of the provider', () => {
    it('is emptied a thousand rows at a time, as far as twenty thousand in one round, and the recent rows stay', async () => {
      const d = desk();
      const old = new Date(Date.now() - 100 * 24 * 60 * MINUTE);

      for (let n = 0; n < 2500; n += 1) d.world.memory.plant('paymentWebhookLog', { provider: 'KONNECT', providerPaymentId: `old-${n}`, outcome: 'ALREADY', receivedAt: old });
      d.world.memory.plant('paymentWebhookLog', { provider: 'KONNECT', providerPaymentId: 'recent', outcome: 'ALREADY', receivedAt: new Date() });

      expect(await d.payments.purgeWebhookLog()).toBe(2500);
      expect(d.world.memory.rows('paymentWebhookLog').length).toBe(1);
      expect(d.world.memory.rows('paymentWebhookLog')[0].providerPaymentId).toBe('recent');
      expect(await d.payments.purgeWebhookLog()).toBe(0);
    });

    it('is emptied once an hour by the timer, also when no provider is set up any more (its calls stay in the table)', async () => {
      const calls = { sweeps: 0, purges: 0 };
      const payments: any = {
        sweepOnline: async () => {
          calls.sweeps += 1;

          return { looked: 0, confirmed: 0, expired: 0, unreachable: 0, dropped: 0 };
        },
        purgeWebhookLog: async () => {
          calls.purges += 1;

          return 0;
        },
      };
      const none = new PaymentExpiryService(payments, new PaymentGatewayService(readGatewayConfig({})));
      const off = new PaymentExpiryService(payments, new PaymentGatewayService(readGatewayConfig({ ...ENV, PAYMENT_EXPIRY_WORKER: 'off' })));

      await none.tick();
      await none.tick();
      expect(calls).toEqual({ sweeps: 0, purges: 1 });

      await off.tick();
      expect(calls).toEqual({ sweeps: 0, purges: 1 });
    });
  });

  describe('the number of a payment at the provider', () => {
    it('names one payment: a second payment cannot carry the same number at the same provider; payments with none do not meet', async () => {
      const d = desk();
      const make = (data: Record<string, unknown>) =>
        d.world.prisma.payment.create({ data: { interventionId: d.job.id, method: 'ONLINE_CARD', amount: 10, currency: 'TND', status: 'CANCELLED', ...data } });

      await make({ provider: 'KONNECT', providerPaymentId: 'same-number' });
      await make({ provider: 'MANUAL', providerPaymentId: 'same-number' });
      await make({ provider: 'KONNECT' });
      await make({ provider: 'KONNECT' });
      await make({ provider: 'CASH', method: 'CASH' });
      await make({ provider: 'CASH', method: 'CASH' });

      const clash = await refusal(() => make({ provider: 'KONNECT', providerPaymentId: 'same-number' }));

      expect(clash).not.toBeNull();
      expect(clash?.message).toContain('Unique constraint failed');
      expect(rowsOf(d).length).toBe(6);
      expect(read('../../../prisma/schema.prisma')).toMatch(/@@unique\(\[provider, providerPaymentId\]\)/);
      expect(read('../../../prisma/schema.prisma')).not.toMatch(/model Payment \{[\s\S]*@@index\(\[expiresAt\]\)[\s\S]*?\n\}/);
    });
  });
});
