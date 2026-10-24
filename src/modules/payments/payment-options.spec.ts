import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { World, emptyWorld } from '../../common/testing/world';
import { scanController } from '../../common/testing/route-roles';
import { resetLocale } from '../../common/locale/locale';
import { Decimal } from '../../common/testing/decimal-double';
import { PAID_WORDS, amountLeft, leftToPay, otherPaymentOpenWords } from './open-payment';
import { PAYMENT_WORDS, accountOf, offeredMethods, paymentOptionsOf, transferReference } from './payment-options';

/**
 * How a customer may pay a job (P2-06), on the real services and a database that answers DECIMAL columns as Decimal objects:
 * what the page of the tracking link reads before it shows a choice, and the check that a request names a way the company offers.
 */
const RIB = '08006012345678901234';
const LINK = 'link-of-a-visitor';
const hashOf = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

function desk(options: { settings?: Record<string, unknown> | null; quote?: number | null; quoteStatus?: string; currency?: string; status?: string } = {}) {
  const world = emptyWorld();
  const client = world.memory.plant('user', { role: 'CLIENT', name: 'Visiteur', isGuest: true });
  const artisan = world.memory.plant('user', { role: 'ARTISAN', name: 'Artisan' });

  world.memory.plant('artisanProfile', { userId: artisan.id, verificationStatus: 'APPROVED' });

  const job = world.memory.plant('intervention', { clientId: client.id, artisanId: artisan.id, status: options.status ?? 'IN_PROGRESS', serviceType: 'PLOMBIER', trackingToken: hashOf(LINK) });
  const other = world.memory.plant('intervention', { clientId: client.id, status: 'CREATED', serviceType: 'PLOMBIER', trackingToken: hashOf('another-link') });
  const amount = options.quote === undefined ? 119 : options.quote;
  const quote =
    amount === null
      ? null
      : world.memory.plant('quote', {
          interventionId: job.id,
          createdById: artisan.id,
          status: options.quoteStatus ?? 'ACCEPTED',
          amountHT: amount,
          taxAmount: 0,
          amountTTC: amount,
          ...(options.currency ? { currency: options.currency } : {}),
        });

  if (options.settings !== null) {
    world.memory.plant('companySettings', { companyName: 'Smart Dépannage', paymentMethods: ['ONLINE', 'CASH', 'BANK_TRANSFER'], rib: RIB, ...(options.settings ?? {}) });
  }

  return { world, client, artisan, job, other, quote };
}

const pay = (world: World, jobId: number, data: Record<string, unknown>) =>
  world.memory.plant('payment', { interventionId: jobId, currency: 'TND', ...data });

async function refusal(work: () => Promise<unknown>): Promise<{ status: number; message: string } | null> {
  try {
    await work();
  } catch (error) {
    const known = error as { getStatus?: () => number; message?: string };

    return { status: typeof known.getStatus === 'function' ? known.getStatus() : 500, message: String(known.message) };
  }

  return null;
}

const optionsOf = (world: World, jobId: number) => paymentOptionsOf(world.prisma as any, world.memory.rows('intervention').find((row) => row.id === jobId)! as { id: number; status: string });
const methodsOf = (answer: Awaited<ReturnType<typeof optionsOf>>) => Object.fromEntries(answer.methods.map((choice) => [choice.method, choice]));

describe('the ways of paying that the company offers (P2-06)', () => {
  it('a row without a list, or with an empty one, offers what a new company starts with', () => {
    const start = ['ONLINE', 'CASH', 'BANK_TRANSFER', 'ONLINE_CARD'].sort();

    expect(offeredMethods(null).sort()).toEqual(start);
    expect(offeredMethods({}).sort()).toEqual(start);
    expect(offeredMethods({ paymentMethods: [] }).sort()).toEqual(start);
    expect(offeredMethods({ paymentMethods: null }).sort()).toEqual(start);
  });

  it('a value that is not a list (a text, a number) is read as no list at all', () => {
    const start = ['ONLINE', 'CASH', 'BANK_TRANSFER', 'ONLINE_CARD'].sort();

    expect(offeredMethods({ paymentMethods: 'CASH' }).sort()).toEqual(start);
    expect(offeredMethods({ paymentMethods: 7 }).sort()).toEqual(start);
    expect(offeredMethods({ paymentMethods: { 0: 'CASH' } }).sort()).toEqual(start);
  });

  it('the same way written twice is offered once', () => {
    expect(offeredMethods({ paymentMethods: ['CASH', 'CASH', 'ONLINE', 'ONLINE_CARD', 'ONLINE'] }).sort()).toEqual(['CASH', 'ONLINE', 'ONLINE_CARD']);
  });

  it('keeps the list of the settings, and "online" stands for the card too', () => {
    expect(offeredMethods({ paymentMethods: ['CASH'] })).toEqual(['CASH']);
    expect(offeredMethods({ paymentMethods: ['BANK_TRANSFER', 'CASH'] }).sort()).toEqual(['BANK_TRANSFER', 'CASH']);
    expect(offeredMethods({ paymentMethods: ['ONLINE'] }).sort()).toEqual(['ONLINE', 'ONLINE_CARD']);
    expect(offeredMethods({ paymentMethods: ['ONLINE_CARD', 'CASH'] }).sort()).toEqual(['CASH', 'ONLINE', 'ONLINE_CARD']);
  });

  it('the account of a transfer is the RIB in one spelling, and nothing when it is not twenty digits', () => {
    expect(accountOf({ rib: RIB })).toBe(RIB);
    expect(accountOf({ rib: '08 006 0123456789012 34' })).toBe(RIB);
    expect(accountOf({ rib: '0800601234' })).toBeNull();
    // one digit short, one digit too many, letters among the digits: not an account to write on a transfer
    expect(accountOf({ rib: '0800601234567890123' })).toBeNull();
    expect(accountOf({ rib: '080060123456789012345' })).toBeNull();
    expect(accountOf({ rib: '0800601234567890123X' })).toBeNull();
    expect(accountOf({ rib: 'TN59 0800 6012 3456 7890 1234' })).toBeNull();
    // however the digits are separated (spaces, dashes, dots), they are the account
    expect(accountOf({ rib: '08-006-0123456789012-34' })).toBe(RIB);
    expect(accountOf({ rib: '08.006.0123456789012.34' })).toBe(RIB);
    expect(accountOf({ rib: ' 08 006 0123456789012 34 ' })).toBe(RIB);
    // a number is not the text of an account (a column that lost its zeros is not one either)
    expect(accountOf({ rib: 12345678901234567890 as unknown as string })).toBeNull();
    expect(accountOf({ rib: 8006012345678901234 as unknown as string })).toBeNull();
    expect(accountOf({ rib: '' })).toBeNull();
    expect(accountOf({ rib: null })).toBeNull();
    expect(accountOf(null)).toBeNull();
  });

  it('what the customer writes on the transfer names the job', () => {
    expect(transferReference(42)).toBe('DEP-42');
  });
});

describe('the payment options of a job (P2-06)', () => {
  beforeEach(() => resetLocale());

  it('a quote that was accepted: cash and transfer can be chosen, the card cannot yet, and the account is given', async () => {
    const { world, job } = desk();
    const answer = await optionsOf(world, job.id);

    expect(answer).toEqual({
      interventionId: job.id,
      currency: 'TND',
      document: 'QUOTE',
      total: 119,
      received: 0,
      amount: 119,
      canPay: true,
      reason: null,
      methods: [
        { method: 'CASH', available: true, reason: null },
        { method: 'BANK_TRANSFER', available: true, reason: null },
        { method: 'ONLINE_CARD', available: false, reason: PAYMENT_WORDS.noProvider },
      ],
      bank: { holder: 'Smart Dépannage', rib: RIB, reference: `DEP-${job.id}` },
      open: null,
    });
  });

  it('answers plain numbers, not the Decimal objects of the columns', async () => {
    const { world, job } = desk({ quote: 12.345 });
    const answer = await optionsOf(world, job.id);

    expect(world.memory.rows('quote')[0].amountTTC).toBeInstanceOf(Decimal);
    expect(typeof answer.total).toBe('number');
    expect(typeof answer.received).toBe('number');
    expect(typeof answer.amount).toBe('number');
    expect(answer.amount).toBe(12.345);
  });

  it('a company with no settings row offers the three it starts with, but has no account to give', async () => {
    const { world, job } = desk({ settings: null });
    const answer = methodsOf(await optionsOf(world, job.id));

    expect(answer.CASH.available).toBe(true);
    expect(answer.BANK_TRANSFER).toEqual({ method: 'BANK_TRANSFER', available: false, reason: PAYMENT_WORDS.noAccount });
    expect((await optionsOf(world, job.id)).bank).toBeNull();
  });

  it('a way the company does not offer is not on the list', async () => {
    const { world, job } = desk({ settings: { paymentMethods: ['CASH'] } });
    const answer = await optionsOf(world, job.id);

    expect(answer.methods.map((choice) => choice.method)).toEqual(['CASH']);
    expect(answer.bank).toBeNull();
    expect(answer.canPay).toBe(true);
  });

  it('only the card offered: nothing can be chosen, and the page is told why', async () => {
    const { world, job } = desk({ settings: { paymentMethods: ['ONLINE'] } });
    const answer = await optionsOf(world, job.id);

    expect(answer.canPay).toBe(false);
    expect(answer.reason).toBe(PAYMENT_WORDS.noProvider);
  });

  it('the account is given in its one spelling, with the name of the company as it is written without its blanks', async () => {
    const { world, job } = desk({ settings: { rib: '08 006 0123456789012 34', companyName: '  Smart Dépannage  ' } });

    expect((await optionsOf(world, job.id)).bank).toEqual({ holder: 'Smart Dépannage', rib: RIB, reference: `DEP-${job.id}` });
  });

  it('a company with no name (or a blank one) has an account without a holder', async () => {
    for (const companyName of [null, '', '   ']) {
      const { world, job } = desk({ settings: { companyName } });

      expect((await optionsOf(world, job.id)).bank).toEqual({ holder: null, rib: RIB, reference: `DEP-${job.id}` });
    }
  });

  it('ways of paying that this page does not know are no choice: nothing to pick, and a sentence says so', async () => {
    const { world, job } = desk({ settings: { paymentMethods: ['CHEQUE'] } });
    const answer = await optionsOf(world, job.id);

    expect(answer.methods).toEqual([]);
    expect(answer.canPay).toBe(false);
    expect(answer.reason).toBe(PAYMENT_WORDS.nothingOffered);
    expect(answer.bank).toBeNull();
  });

  it('two payments that wait (a cash payment, then a transfer): the last one is shown', async () => {
    const { world, job } = desk();

    pay(world, job.id, { method: 'CASH', status: 'AWAITING_CONFIRMATION', amount: 119 });

    const later = pay(world, job.id, { method: 'BANK_TRANSFER', status: 'AWAITING_CONFIRMATION', amount: 119 });

    expect((await optionsOf(world, job.id)).open).toMatchObject({ id: later.id, method: 'BANK_TRANSFER' });
  });

  it('a failure of the database is not turned into a sentence for the customer', async () => {
    const { world, job } = desk();
    const db: any = new Proxy(world.prisma as any, {
      get: (target, name) =>
        name === 'payment'
          ? new Proxy(target.payment, {
              get: (model, method) =>
                method === 'findMany'
                  ? async () => {
                      throw new Error('base indisponible');
                    }
                  : typeof model[method] === 'function'
                    ? model[method].bind(model)
                    : model[method],
            })
          : target[name],
    });

    expect(await refusal(() => paymentOptionsOf(db, { id: job.id, status: job.status }))).toEqual({ status: 500, message: 'base indisponible' });
  });

  it('the payments are read once: what is received, what waits and what is left come from the same moment', async () => {
    const { world, job } = desk();
    let reads = 0;
    const db: any = new Proxy(world.prisma as any, {
      get: (target, name) =>
        name === 'payment'
          ? new Proxy(target.payment, {
              get: (model, method) =>
                method === 'findMany'
                  ? async (...args: unknown[]) => {
                      reads += 1;

                      return model.findMany(...args);
                    }
                  : typeof model[method] === 'function'
                    ? model[method].bind(model)
                    : model[method],
            })
          : target[name],
    });

    await paymentOptionsOf(db, { id: job.id, status: job.status });

    expect(reads).toBe(1);
  });

  it('a transfer without an account to pay into is not offered, and no account is shown', async () => {
    const { world, job } = desk({ settings: { rib: null } });
    const answer = await optionsOf(world, job.id);

    expect(methodsOf(answer).BANK_TRANSFER).toEqual({ method: 'BANK_TRANSFER', available: false, reason: PAYMENT_WORDS.noAccount });
    expect(answer.bank).toBeNull();
    expect(answer.canPay).toBe(true);
  });

  it('a job without an accepted quote offers nothing, and says so (a quote that was only sent is not one)', async () => {
    for (const settings of [{ quote: null }, { quote: 119, quoteStatus: 'SENT' }]) {
      const { world, job } = desk(settings);
      const answer = await optionsOf(world, job.id);

      expect(answer.canPay).toBe(false);
      expect(answer.reason).toBe(PAYMENT_WORDS.noQuote);
      expect(answer.amount).toBeNull();
      expect(answer.bank).toBeNull();
      expect(answer.methods.every((choice) => !choice.available && choice.reason === PAYMENT_WORDS.noQuote)).toBe(true);
    }
  });

  it('a job that is paid offers nothing, and the account is not shown any more', async () => {
    const { world, job } = desk();

    pay(world, job.id, { method: 'CASH', status: 'PAID', amount: 119, amountRefunded: 0 });

    const answer = await optionsOf(world, job.id);

    expect(answer.canPay).toBe(false);
    expect(answer.reason).toBe('Cette mission est déjà payée.');
    expect(answer.received).toBe(119);
    expect(answer.bank).toBeNull();
  });

  it('what was paid already is not asked for twice', async () => {
    const { world, job } = desk();

    pay(world, job.id, { method: 'BANK_TRANSFER', status: 'PAID', amount: 50, amountRefunded: 0 });

    const answer = await optionsOf(world, job.id);

    expect(answer.received).toBe(50);
    expect(answer.amount).toBe(69);
    expect(answer.total).toBe(119);
    expect(answer.canPay).toBe(true);
  });

  it('a quote in another currency than the company is asked in full, in its own currency', async () => {
    const { world, job } = desk({ currency: 'EUR' });
    const answer = await optionsOf(world, job.id);

    expect(answer.currency).toBe('EUR');
    expect(answer.amount).toBe(119);
  });

  it('a transfer that waits for its confirmation: it is still on offer (to send its reference), every other way is in the way', async () => {
    const { world, job } = desk();
    const waiting = pay(world, job.id, { method: 'BANK_TRANSFER', status: 'AWAITING_CONFIRMATION', amount: 119 });
    const answer = await optionsOf(world, job.id);
    const methods = methodsOf(answer);

    expect(methods.BANK_TRANSFER.available).toBe(true);
    expect(methods.CASH).toEqual({ method: 'CASH', available: false, reason: otherPaymentOpenWords(waiting) });
    expect(methods.CASH.reason).toContain('en attente pour cette mission');
    expect(answer.open).toMatchObject({ id: waiting.id, method: 'BANK_TRANSFER', status: 'AWAITING_CONFIRMATION' });
    expect(answer.canPay).toBe(true);
  });

  it('cash that waits for its confirmation (asked for by the customer) is in the way of a transfer', async () => {
    const { world, job } = desk();

    pay(world, job.id, { method: 'CASH', status: 'AWAITING_CONFIRMATION', amount: 119 });

    const methods = methodsOf(await optionsOf(world, job.id));

    expect(methods.CASH.available).toBe(true);
    expect(methods.BANK_TRANSFER.available).toBe(false);
    expect(methods.BANK_TRANSFER.reason).toContain('en attente pour cette mission');
  });

  it('cash that waits for another amount is in the way even of its own method (the request would be refused)', async () => {
    const { world, job } = desk();

    pay(world, job.id, { method: 'CASH', status: 'AWAITING_CONFIRMATION', amount: 50 });

    const methods = methodsOf(await optionsOf(world, job.id));

    expect(methods.CASH.available).toBe(false);
    expect(methods.BANK_TRANSFER.available).toBe(false);
  });

  it('a transfer that waits is the same request again whatever the document asks now: the reference can still be sent', async () => {
    const { world, job } = desk();
    const first = await world.svc.guest.createGuestPayment(job.id, LINK, { method: 'BANK_TRANSFER' });

    // An invoice, larger than the quote, is issued after the transfer was asked for.
    world.memory.plant('invoice', { interventionId: job.id, status: 'ISSUED', amountHT: 105, taxAmount: 20, amountTTC: 125 });

    const options = await world.svc.guest.getPaymentOptions(job.id, LINK);
    const methods = methodsOf(options);

    expect(options.amount).toBe(125);
    expect(options.open).toMatchObject({ id: first.payment.id, method: 'BANK_TRANSFER' });
    expect(methods.BANK_TRANSFER.available).toBe(true);
    expect(methods.CASH.available).toBe(false);

    const again = await world.svc.guest.createGuestPayment(job.id, LINK, { method: 'BANK_TRANSFER', reference: 'VIR-789' });

    expect(again.replayed).toBe(true);
    expect(again.payment.id).toBe(first.payment.id);
    expect(again.payment.reference).toBe('VIR-789');
    expect(Number(again.payment.amount)).toBe(119);
    expect(world.memory.rows('payment')).toHaveLength(1);
    expect(await refusal(() => world.svc.guest.createGuestPayment(job.id, LINK, { method: 'CASH' }))).toMatchObject({ status: 409 });
  });

  it('the same holds for a signed-in customer who names no amount', async () => {
    const { world, client, job } = desk();

    world.memory.rows('user').find((user) => user.id === client.id)!.isGuest = false;

    await world.svc.payments.createClientPaymentRequest(client.id, job.id, { method: 'BANK_TRANSFER' } as any);
    world.memory.plant('invoice', { interventionId: job.id, status: 'ISSUED', amountHT: 105, taxAmount: 20, amountTTC: 125 });

    const again = await world.svc.payments.createClientPaymentRequest(client.id, job.id, { method: 'BANK_TRANSFER', reference: 'VIR-1' } as any);

    expect(world.memory.rows('payment')).toHaveLength(1);
    expect(world.memory.rows('payment')[0].reference).toBe('VIR-1');
    expect(again).toBeDefined();

    // a typed amount is a request of its own: the open transfer of another amount is in the way
    expect((await refusal(() => world.svc.payments.createClientPaymentRequest(client.id, job.id, { method: 'BANK_TRANSFER', amount: 30 } as any)))?.status).toBe(409);
  });

  it('a card request that nobody can pay is not in the way and is not shown as a payment that waits', async () => {
    const { world, job } = desk();

    pay(world, job.id, { method: 'ONLINE', status: 'PENDING', amount: 119, providerPaymentId: null });

    const answer = await optionsOf(world, job.id);

    expect(answer.open).toBeNull();
    expect(methodsOf(answer).CASH.available).toBe(true);
    expect(methodsOf(answer).BANK_TRANSFER.available).toBe(true);
  });

  it('a payment that was cancelled or failed is not open', async () => {
    const { world, job } = desk();

    pay(world, job.id, { method: 'BANK_TRANSFER', status: 'CANCELLED', amount: 119 });
    pay(world, job.id, { method: 'CASH', status: 'FAILED', amount: 119 });

    const answer = await optionsOf(world, job.id);

    expect(answer.open).toBeNull();
    expect(answer.methods.filter((choice) => choice.method !== 'ONLINE_CARD').every((choice) => choice.available)).toBe(true);
  });

  it('the open payment is shown as the customer reads a payment: nothing of the back office', async () => {
    const { world, job } = desk();

    pay(world, job.id, { method: 'BANK_TRANSFER', status: 'AWAITING_CONFIRMATION', amount: 119, adminNote: 'NOTE-DU-BACK-OFFICE', providerPaymentId: 'PROVIDER-ID-SECRET', cancelReason: 'RAISON-INTERNE' });

    const text = JSON.stringify((await optionsOf(world, job.id)).open);

    expect(text).toContain('AWAITING_CONFIRMATION');
    expect(text).not.toContain('NOTE-DU-BACK-OFFICE');
    expect(text).not.toContain('PROVIDER-ID-SECRET');
    expect(text).not.toContain('RAISON-INTERNE');
  });

  it('a job whose invoice is out is paid by the invoice, not the quote', async () => {
    const { world, job } = desk();

    world.memory.plant('invoice', { interventionId: job.id, status: 'ISSUED', amountHT: 100, taxAmount: 19, amountTTC: 125 });

    const answer = await optionsOf(world, job.id);

    expect(answer.document).toBe('INVOICE');
    expect(answer.total).toBe(125);
    // what the invoice asks, not what the quote asked: the customer owes the invoice
    expect(answer.amount).toBe(125);
  });

  it('an invoice that is still a draft is not what is paid: the options are the quote\'s, as the customer sees the job', async () => {
    const { world, job } = desk();

    world.memory.plant('invoice', { interventionId: job.id, status: 'DRAFT', amountHT: 100, taxAmount: 40, amountTTC: 140 });

    const answer = await optionsOf(world, job.id);

    expect(answer.document).toBe('QUOTE');
    expect(answer.total).toBe(119);
    expect(answer.amount).toBe(119);
  });

  it('an invoice that was cancelled asks nothing either', async () => {
    const { world, job } = desk();

    world.memory.plant('invoice', { interventionId: job.id, status: 'CANCELLED', amountHT: 100, taxAmount: 40, amountTTC: 140 });

    expect(await optionsOf(world, job.id)).toMatchObject({ document: 'QUOTE', total: 119, amount: 119 });
  });

  it('a request that was cancelled has nothing to pay, whatever its quote says; the other stages of a job still take payment', async () => {
    for (const status of ['CANCELLED']) {
      const { world, job } = desk({ status });
      const answer = await optionsOf(world, job.id);

      expect(answer.canPay).toBe(false);
      expect(answer.reason).toBe(PAYMENT_WORDS.cancelled);
      expect(answer.amount).toBeNull();
      expect(answer.bank).toBeNull();
      expect(answer.methods.every((choice) => !choice.available && choice.reason === PAYMENT_WORDS.cancelled)).toBe(true);
    }

    for (const status of ['QUOTE_ACCEPTED', 'ARTISAN_ARRIVED', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'PAYMENT_PENDING', 'INVOICE_SENT', 'INVOICE_READY', 'DISPUTED']) {
      const { world, job } = desk({ status });

      expect((await optionsOf(world, job.id)).canPay).toBe(true);
    }
  });

  it('cash the technician declared in part (50 of 119): 69 is left, and until the team confirms it every way is in the way of the rest', async () => {
    const { world, artisan, job } = desk({ status: 'ARTISAN_ARRIVED' });

    await world.svc.cashLedger.collectCash(artisan.id, 'ARTISAN', job.id, { amount: 50, requestKey: 'declared-in-part-0001' } as any);

    const answer = await optionsOf(world, job.id);
    const methods = methodsOf(answer);

    expect(answer.received).toBe(50);
    expect(answer.amount).toBe(69);
    expect(methods.CASH.available).toBe(false);
    expect(methods.BANK_TRANSFER.available).toBe(false);
    expect(methods.CASH.reason).toContain('en attente pour cette mission');
    expect(answer.open).toMatchObject({ method: 'CASH', status: 'AWAITING_CONFIRMATION' });
    // and the request is refused with the sentence the options gave
    expect(await refusal(() => world.svc.guest.createGuestPayment(job.id, LINK, { method: 'CASH' }))).toEqual({ status: 409, message: methods.CASH.reason });
  });

  it('the account stays given while another payment waits (the invoice carries it); the page shows it only where a transfer can be made', async () => {
    const { world, job } = desk();

    pay(world, job.id, { method: 'CASH', status: 'AWAITING_CONFIRMATION', amount: 119 });

    const answer = await optionsOf(world, job.id);

    expect(answer.bank).toEqual({ holder: 'Smart Dépannage', rib: RIB, reference: `DEP-${job.id}` });
    expect(methodsOf(answer).BANK_TRANSFER.available).toBe(false);
  });
});

describe('the options and the payment request from the tracking link (P2-06)', () => {
  beforeEach(() => resetLocale());

  it('the link of the job gets the options; another link, a made-up link and no link are not found', async () => {
    const { world, job } = desk();
    const guest = world.svc.guest;

    expect(await guest.getPaymentOptions(job.id, LINK)).toMatchObject({ interventionId: job.id, canPay: true, amount: 119 });

    for (const token of ['another-link', 'made-up', '', undefined]) {
      expect(await refusal(() => guest.getPaymentOptions(job.id, token as any))).toMatchObject({ status: 404 });
    }
  });

  it('the account of the company is not given to a link of another job', async () => {
    const { world, other } = desk();

    expect(await refusal(() => world.svc.guest.getPaymentOptions(other.id, LINK))).toMatchObject({ status: 404 });
  });

  it('asking to pay in a way the company does not offer is refused, and nothing is written', async () => {
    const { world, job } = desk({ settings: { paymentMethods: ['CASH'] } });
    const attempt = await refusal(() => world.svc.guest.createGuestPayment(job.id, LINK, { method: 'BANK_TRANSFER' }));

    expect(attempt).toEqual({ status: 400, message: PAYMENT_WORDS.notOffered });
    expect(world.memory.rows('payment')).toHaveLength(0);
  });

  it('asking for a transfer when the company has no account is refused', async () => {
    const { world, job } = desk({ settings: { rib: null } });

    expect(await refusal(() => world.svc.guest.createGuestPayment(job.id, LINK, { method: 'BANK_TRANSFER' }))).toEqual({ status: 400, message: PAYMENT_WORDS.noAccount });
    expect(world.memory.rows('payment')).toHaveLength(0);
  });

  it('cash and the card are asked for whether or not the company has an account to pay a transfer into', async () => {
    const cash = desk({ settings: { rib: null } });
    const card = desk({ settings: { rib: null } });

    expect((await cash.world.svc.guest.createGuestPayment(cash.job.id, LINK, { method: 'CASH' })).payment).toMatchObject({ method: 'CASH', status: 'AWAITING_CONFIRMATION' });
    expect((await card.world.svc.guest.createGuestPayment(card.job.id, LINK, { method: 'ONLINE_CARD' })).payment).toMatchObject({ method: 'ONLINE_CARD', status: 'PENDING' });
  });

  it('a request that was cancelled takes no payment request, from the link or from a signed-in customer', async () => {
    const { world, client, job } = desk({ status: 'CANCELLED' });
    const options = await world.svc.guest.getPaymentOptions(job.id, LINK);

    expect(await refusal(() => world.svc.guest.createGuestPayment(job.id, LINK, { method: 'CASH' }))).toEqual({ status: 400, message: PAYMENT_WORDS.cancelled });
    expect(options.reason).toBe(PAYMENT_WORDS.cancelled);

    world.memory.rows('user').find((user) => user.id === client.id)!.isGuest = false;

    expect(await refusal(() => world.svc.payments.createClientPaymentRequest(client.id, job.id, { method: 'CASH' } as any))).toEqual({ status: 400, message: PAYMENT_WORDS.cancelled });
    expect(world.memory.rows('payment')).toHaveLength(0);
  });

  it('a request that is finished, being paid or in dispute still takes a payment request, from the link and from a signed-in customer', async () => {
    for (const status of ['QUOTE_ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'PAYMENT_PENDING', 'INVOICE_SENT', 'DISPUTED']) {
      const link = desk({ status });
      const signed = desk({ status });

      expect((await link.world.svc.guest.createGuestPayment(link.job.id, LINK, { method: 'CASH' })).payment).toMatchObject({ method: 'CASH', status: 'AWAITING_CONFIRMATION' });

      signed.world.memory.rows('user').find((user) => user.id === signed.client.id)!.isGuest = false;

      await signed.world.svc.payments.createClientPaymentRequest(signed.client.id, signed.job.id, { method: 'CASH' } as any);

      expect(signed.world.memory.rows('payment')).toHaveLength(1);
      expect(signed.world.memory.rows('payment')[0]).toMatchObject({ method: 'CASH' });
    }
  });

  it('what the invoice asks is what the request asks, and the payment is linked to the invoice', async () => {
    const { world, job, quote } = desk();
    const invoice = world.memory.plant('invoice', { interventionId: job.id, status: 'ISSUED', amountHT: 105, taxAmount: 20, amountTTC: 125 });
    const options = await world.svc.guest.getPaymentOptions(job.id, LINK);
    const asked = await world.svc.guest.createGuestPayment(job.id, LINK, { method: 'CASH' });

    expect(options.amount).toBe(125);
    expect(Number(asked.payment.amount)).toBe(125);
    expect(world.memory.rows('payment')[0].invoiceId).toBe(invoice.id);
    // and the quote it came from stays linked too
    expect(world.memory.rows('payment')[0].quoteId).toBe(quote?.id);
  });

  it('the invoice decides the currency and the amount left, not the quote it came from', async () => {
    const { world, job } = desk({ currency: 'EUR' });
    const invoice = world.memory.plant('invoice', { interventionId: job.id, status: 'ISSUED', amountHT: 105, taxAmount: 20, amountTTC: 125, currency: 'TND' });

    pay(world, job.id, { method: 'BANK_TRANSFER', amount: 25, status: 'PAID', amountRefunded: 0, invoiceId: invoice.id });

    const options = await world.svc.guest.getPaymentOptions(job.id, LINK);
    const asked = await world.svc.guest.createGuestPayment(job.id, LINK, { method: 'CASH' });

    // 125 of the invoice, less the 25 already kept: the quote (in another currency) does not turn the invoice into a foreign document.
    expect(options.currency).toBe('TND');
    expect(options.amount).toBe(100);
    expect(Number(asked.payment.amount)).toBe(100);
    expect(asked.payment.currency).toBe('TND');
  });

  it('with no invoice yet, the quote decides the currency of the request', async () => {
    const { world, job } = desk({ currency: 'EUR' });
    const options = await world.svc.guest.getPaymentOptions(job.id, LINK);
    const asked = await world.svc.guest.createGuestPayment(job.id, LINK, { method: 'CASH' });

    expect(options.currency).toBe('EUR');
    expect(options.amount).toBe(119);
    expect(asked.payment.currency).toBe('EUR');
  });

  it('a transfer a signed-in customer asked for is theirs on the tracking page too, whatever the invoice asks later', async () => {
    const { world, client, job } = desk();

    world.memory.rows('user').find((user) => user.id === client.id)!.isGuest = false;

    await world.svc.payments.createClientPaymentRequest(client.id, job.id, { method: 'BANK_TRANSFER' } as any);

    const first = { payment: world.memory.rows('payment')[0] };

    world.memory.plant('invoice', { interventionId: job.id, status: 'ISSUED', amountHT: 105, taxAmount: 20, amountTTC: 125 });

    const options = await world.svc.guest.getPaymentOptions(job.id, LINK);
    const again = await world.svc.guest.createGuestPayment(job.id, LINK, { method: 'BANK_TRANSFER', reference: 'VIR-2' });

    expect(world.memory.rows('payment')[0].createdById).toBe(client.id);
    expect(methodsOf(options).BANK_TRANSFER.available).toBe(true);
    expect(again.replayed).toBe(true);
    expect(again.payment.id).toBe(first.payment.id);
    expect(world.memory.rows('payment')).toHaveLength(1);
  });

  it('a signed-in customer who types the amount of a transfer asks for that amount: the transfer asked for earlier is another request, not adopted', async () => {
    const { world, client, job } = desk();

    world.memory.rows('user').find((user) => user.id === client.id)!.isGuest = false;

    await world.svc.payments.createClientPaymentRequest(client.id, job.id, { method: 'BANK_TRANSFER' } as any);
    world.memory.plant('invoice', { interventionId: job.id, status: 'ISSUED', amountHT: 105, taxAmount: 20, amountTTC: 125 });

    const typed = await refusal(() => world.svc.payments.createClientPaymentRequest(client.id, job.id, { method: 'BANK_TRANSFER', amount: 125, reference: 'VIR-9' } as any));

    expect(typed?.status).toBe(409);
    expect(world.memory.rows('payment')).toHaveLength(1);
    expect(Number(world.memory.rows('payment')[0].amount)).toBe(119);
    expect(world.memory.rows('payment')[0].reference ?? null).toBeNull();
  });

  it('a transfer larger than what is left is not the same request: the team could not confirm it, so the customer is told to ask for its cancellation', async () => {
    const { world, job } = desk();

    await world.svc.guest.createGuestPayment(job.id, LINK, { method: 'BANK_TRANSFER' });
    // The invoice that is issued afterwards asks less (100) than the transfer that was asked for (119).
    world.memory.plant('invoice', { interventionId: job.id, status: 'ISSUED', amountHT: 84, taxAmount: 16, amountTTC: 100 });

    const options = await world.svc.guest.getPaymentOptions(job.id, LINK);
    const attempt = await refusal(() => world.svc.guest.createGuestPayment(job.id, LINK, { method: 'BANK_TRANSFER', reference: 'VIR-1' }));

    expect(options.amount).toBe(100);
    expect(methodsOf(options).BANK_TRANSFER.available).toBe(false);
    expect(attempt?.status).toBe(409);
    expect(attempt?.message).toBe(methodsOf(options).BANK_TRANSFER.reason);
    expect(world.memory.rows('payment')[0].reference ?? null).toBeNull();
  });

  it('a transfer the back office entered is not adopted by the customer, and its reference is not overwritten', async () => {
    const { world, client, job } = desk();
    const admin = world.memory.plant('user', { role: 'ADMIN', name: 'Admin' });

    pay(world, job.id, { method: 'BANK_TRANSFER', status: 'AWAITING_CONFIRMATION', amount: 30, reference: 'ADM-1', createdById: admin.id });

    const options = await world.svc.guest.getPaymentOptions(job.id, LINK);

    expect(methodsOf(options).BANK_TRANSFER.available).toBe(false);
    expect((await refusal(() => world.svc.guest.createGuestPayment(job.id, LINK, { method: 'BANK_TRANSFER', reference: 'CLI-1' })))?.status).toBe(409);

    world.memory.rows('user').find((user) => user.id === client.id)!.isGuest = false;

    expect((await refusal(() => world.svc.payments.createClientPaymentRequest(client.id, job.id, { method: 'BANK_TRANSFER', reference: 'CLI-2' } as any)))?.status).toBe(409);
    expect(world.memory.rows('payment')).toHaveLength(1);
    expect(world.memory.rows('payment')[0].reference).toBe('ADM-1');
  });

  it('a signed-in customer pays an invoice that is out, never a draft or a cancelled one, even when they name it', async () => {
    const { world, client, job } = desk();
    const invoice = world.memory.plant('invoice', { interventionId: job.id, status: 'DRAFT', amountHT: 100, taxAmount: 40, amountTTC: 140 });
    const named = () => refusal(() => world.svc.payments.createClientPaymentRequest(client.id, job.id, { method: 'CASH', invoiceId: invoice.id } as any));

    world.memory.rows('user').find((user) => user.id === client.id)!.isGuest = false;

    expect(await named()).toEqual({ status: 404, message: 'Facture introuvable.' });
    world.memory.rows('invoice')[0].status = 'CANCELLED';
    expect(await named()).toEqual({ status: 404, message: 'Facture introuvable.' });
    expect(world.memory.rows('payment')).toHaveLength(0);

    world.memory.rows('invoice')[0].status = 'ISSUED';
    expect(await named()).toBeNull();
    expect(world.memory.rows('payment')[0].invoiceId).toBe(invoice.id);
    expect(Number(world.memory.rows('payment')[0].amount)).toBe(140);
  });

  it('the currency of a signed-in request is the one of the invoice that is paid, not of the quote it came from', async () => {
    const { world, client, job } = desk({ currency: 'EUR' });

    world.memory.plant('invoice', { interventionId: job.id, status: 'ISSUED', amountHT: 105, taxAmount: 20, amountTTC: 125, currency: 'TND' });
    world.memory.rows('user').find((user) => user.id === client.id)!.isGuest = false;
    await world.svc.payments.createClientPaymentRequest(client.id, job.id, { method: 'CASH' } as any);

    expect(world.memory.rows('payment')[0].currency).toBe('TND');
    expect(Number(world.memory.rows('payment')[0].amount)).toBe(125);
  });

  it('a customer who is signed in and names nothing is asked the invoice that is out, like the visitor of the link, and the payment is linked to it', async () => {
    const { world, client, job } = desk();
    const invoice = world.memory.plant('invoice', { interventionId: job.id, status: 'ISSUED', amountHT: 105, taxAmount: 20, amountTTC: 125 });

    world.memory.rows('user').find((user) => user.id === client.id)!.isGuest = false;
    await world.svc.payments.createClientPaymentRequest(client.id, job.id, { method: 'CASH' } as any);

    expect(world.memory.rows('payment')).toHaveLength(1);
    expect(Number(world.memory.rows('payment')[0].amount)).toBe(125);
    expect(world.memory.rows('payment')[0].invoiceId).toBe(invoice.id);
  });

  it('a signed-in customer who types an amount makes a request of that amount, linked to no invoice', async () => {
    const { world, client, job } = desk();

    world.memory.plant('invoice', { interventionId: job.id, status: 'ISSUED', amountHT: 105, taxAmount: 20, amountTTC: 125 });
    world.memory.rows('user').find((user) => user.id === client.id)!.isGuest = false;
    await world.svc.payments.createClientPaymentRequest(client.id, job.id, { method: 'CASH', amount: 30 } as any);

    expect(Number(world.memory.rows('payment')[0].amount)).toBe(30);
    expect(world.memory.rows('payment')[0].invoiceId ?? null).toBeNull();
  });

  it('a draft invoice is not asked of a signed-in customer either', async () => {
    const { world, client, job } = desk();

    world.memory.plant('invoice', { interventionId: job.id, status: 'DRAFT', amountHT: 100, taxAmount: 40, amountTTC: 140 });
    world.memory.rows('user').find((user) => user.id === client.id)!.isGuest = false;
    await world.svc.payments.createClientPaymentRequest(client.id, job.id, { method: 'CASH' } as any);

    expect(Number(world.memory.rows('payment')[0].amount)).toBe(119);
    expect(world.memory.rows('payment')[0].invoiceId ?? null).toBeNull();
  });

  it('an invoice that is out can be paid from the link even when no quote was accepted', async () => {
    const { world, job } = desk({ quote: null });
    const invoice = world.memory.plant('invoice', { interventionId: job.id, status: 'ISSUED', amountHT: 105, taxAmount: 20, amountTTC: 125 });
    const options = await world.svc.guest.getPaymentOptions(job.id, LINK);

    expect(options).toMatchObject({ document: 'INVOICE', total: 125, amount: 125, canPay: true });

    const asked = await world.svc.guest.createGuestPayment(job.id, LINK, { method: 'CASH' });

    expect(Number(asked.payment.amount)).toBe(125);
    expect(world.memory.rows('payment')[0].invoiceId).toBe(invoice.id);
    expect(world.memory.rows('payment')[0].quoteId ?? null).toBeNull();
  });

  it('a job that is paid takes no request, with the sentence the options give', async () => {
    const { world, job } = desk();

    pay(world, job.id, { method: 'CASH', amount: 119, status: 'PAID', amountRefunded: 0 });

    const options = await world.svc.guest.getPaymentOptions(job.id, LINK);

    expect(options).toMatchObject({ canPay: false, reason: PAID_WORDS, amount: null });
    expect(await refusal(() => world.svc.guest.createGuestPayment(job.id, LINK, { method: 'CASH' }))).toEqual({ status: 400, message: PAID_WORDS });
    expect(world.memory.rows('payment')).toHaveLength(1);
  });

  it('a draft invoice does not change what the request asks', async () => {
    const { world, job } = desk();

    world.memory.plant('invoice', { interventionId: job.id, status: 'DRAFT', amountHT: 100, taxAmount: 40, amountTTC: 140 });

    const asked = await world.svc.guest.createGuestPayment(job.id, LINK, { method: 'CASH' });

    expect(Number(asked.payment.amount)).toBe(119);
    expect(world.memory.rows('payment')[0].invoiceId ?? null).toBeNull();
  });

  it('a job without an accepted quote takes no payment request, with the sentence the options give', async () => {
    const { world, job } = desk({ quote: null });
    const options = await world.svc.guest.getPaymentOptions(job.id, LINK);

    expect(await refusal(() => world.svc.guest.createGuestPayment(job.id, LINK, { method: 'CASH' }))).toEqual({ status: 400, message: PAYMENT_WORDS.noQuote });
    expect(options.reason).toBe(PAYMENT_WORDS.noQuote);
  });

  it('the options are never kept by a cache: the route says so (the account and what waits change)', () => {
    const controller = fs.readFileSync(path.join(__dirname, '../guest/guest.controller.ts'), 'utf8');
    const route = scanController(controller, []).find((item) => item.method === 'GET' && item.path === '/guest/interventions/:id/payment-options');

    expect(route).toBeDefined();
    expect(route!.source).toContain("@Header('Cache-Control', 'no-store')");
  });

  it('cash is asked for, and the options then show it as the payment that waits', async () => {
    const { world, job } = desk();
    const asked = await world.svc.guest.createGuestPayment(job.id, LINK, { method: 'CASH' });

    expect(asked.payment).toMatchObject({ method: 'CASH', status: 'AWAITING_CONFIRMATION' });
    expect(String(asked.payment.amount)).toBe('119');

    const answer = await world.svc.guest.getPaymentOptions(job.id, LINK);

    expect(answer.open).toMatchObject({ id: asked.payment.id, method: 'CASH' });
    expect(methodsOf(answer).BANK_TRANSFER.available).toBe(false);
  });

  it('a transfer is asked for, then the reference is sent with the same request: the open payment keeps it', async () => {
    const { world, job } = desk();
    const first = await world.svc.guest.createGuestPayment(job.id, LINK, { method: 'BANK_TRANSFER' });
    const second = await world.svc.guest.createGuestPayment(job.id, LINK, { method: 'BANK_TRANSFER', reference: 'VIR-123' });

    expect(second.replayed).toBe(true);
    expect(second.payment.id).toBe(first.payment.id);
    expect(second.payment.reference).toBe('VIR-123');
    expect(world.memory.rows('payment')).toHaveLength(1);
  });

  it('another way of paying while one waits is refused with the sentence the options gave', async () => {
    const { world, job } = desk();

    await world.svc.guest.createGuestPayment(job.id, LINK, { method: 'BANK_TRANSFER' });

    const options = methodsOf(await world.svc.guest.getPaymentOptions(job.id, LINK));
    const attempt = await refusal(() => world.svc.guest.createGuestPayment(job.id, LINK, { method: 'CASH' }));

    expect(attempt?.status).toBe(409);
    expect(attempt?.message).toBe(options.CASH.reason);
  });

  it('the signed-in customer is held to the same list of ways', async () => {
    const { world, client, job } = desk({ settings: { paymentMethods: ['CASH'] } });

    world.memory.rows('user').find((user) => user.id === client.id)!.isGuest = false;

    const attempt = await refusal(() => world.svc.payments.createClientPaymentRequest(client.id, job.id, { method: 'BANK_TRANSFER' } as any));

    expect(attempt).toEqual({ status: 400, message: PAYMENT_WORDS.notOffered });
    expect(world.memory.rows('payment')).toHaveLength(0);
  });
});

describe('the invoice on the tracking answer (P2-06)', () => {
  it('an invoice that is out comes with its lines, for the page to print', async () => {
    const { world, job } = desk();
    const invoice = world.memory.plant('invoice', { interventionId: job.id, status: 'ISSUED', invoiceNumber: 'F-2026-0001', amountHT: 100, taxAmount: 19, amountTTC: 119, clientName: 'Visiteur' });

    world.memory.plant('invoiceItem', { invoiceId: invoice.id, label: 'Remplacement du joint', quantity: 2, unitPrice: 50, total: 100 });

    const answer = await world.svc.guest.track(job.id, LINK);

    // The amounts of a document are Decimal columns: here the service answers them as Decimal objects, and the interceptor of the
    // server (MoneyNumbersInterceptor) turns them into numbers at the edge; either way they read as the figure.
    expect(answer.invoice).toMatchObject({ invoiceNumber: 'F-2026-0001' });
    expect(String(answer.invoice.amountTTC)).toBe('119');
    expect(answer.invoice.items).toHaveLength(1);
    expect(answer.invoice.items[0]).toMatchObject({ label: 'Remplacement du joint', quantity: 2 });
    expect(String(answer.invoice.items[0].unitPrice)).toBe('50');
    expect(String(answer.invoice.items[0].total)).toBe('100');
  });

  it('the lines of the invoice come in the order they were written', async () => {
    const { world, job } = desk();
    const invoice = world.memory.plant('invoice', { interventionId: job.id, status: 'ISSUED', invoiceNumber: 'F-2026-0002', amountHT: 100, taxAmount: 19, amountTTC: 119 });

    // Stored out of order, so that only the order the query asks for puts them right.
    for (const [id, label] of [[30, 'Troisième'], [10, 'Première'], [20, 'Deuxième']] as const) world.memory.plant('invoiceItem', { id, invoiceId: invoice.id, label, quantity: 1, unitPrice: 10, total: 10 });

    const answer = await world.svc.guest.track(job.id, LINK);

    expect(answer.invoice.items.map((item: { label: string }) => item.label)).toEqual(['Première', 'Deuxième', 'Troisième']);
  });

  it('an invoice that is still a draft is not the customer\'s: there is none on the page', async () => {
    const { world, job } = desk();
    const invoice = world.memory.plant('invoice', { interventionId: job.id, status: 'DRAFT', invoiceNumber: 'BROUILLON-1', amountHT: 100, taxAmount: 19, amountTTC: 119 });

    world.memory.plant('invoiceItem', { invoiceId: invoice.id, label: 'Ligne', quantity: 1, unitPrice: 100, total: 100 });

    const answer = await world.svc.guest.track(job.id, LINK);

    expect(answer.invoice).toBeNull();
  });
});

describe('what is left to ask (P2-06)', () => {
  it('is what remains of the document, never more than the document, and nothing when nothing remains', () => {
    expect(amountLeft({ remaining: 40 }, 100, 'TND')).toBe(40);
    expect(amountLeft({ remaining: 100 }, 100, 'TND')).toBe(100);
    expect(amountLeft({ remaining: 140 }, 100, 'TND')).toBe(100);
    expect(amountLeft({ remaining: 0 }, 100, 'TND')).toBeNull();
    expect(amountLeft({ remaining: -5 }, 100, 'TND')).toBeNull();
  });

  it('is the whole document when there is nothing to set the payments against, or when it is in another currency', () => {
    expect(amountLeft({ remaining: null }, 100, 'TND')).toBe(100);
    expect(amountLeft({ remaining: null }, 100, null)).toBe(100);
    expect(amountLeft({ remaining: 40 }, 100, 'EUR')).toBe(100);
    expect(amountLeft({ remaining: 0 }, 100, 'EUR')).toBe(100);
  });

  it('is read from the payments of the job by the request that does not say how much', async () => {
    const { world, job } = desk();

    pay(world, job.id, { method: 'CASH', amount: 19, status: 'PAID', amountRefunded: 0 });

    expect(await leftToPay(world.prisma as any, job.id, 119, 'TND')).toBe(100);
    expect(await leftToPay(world.prisma as any, job.id, 119, 'EUR')).toBe(119);
  });

  it('is asked in full for a job that has no document to set the payments against', async () => {
    const { world, job } = desk({ quote: null });

    expect(await leftToPay(world.prisma as any, job.id, 80, 'TND')).toBe(80);
  });
});
