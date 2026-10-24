import * as crypto from 'crypto';

import { World, emptyWorld } from '../../common/testing/world';
import { resetLocale } from '../../common/locale/locale';
import { lockJob } from '../assignment/artisan-lock';

/**
 * What a quote does from the day it is written to the day it is answered (P2-04), on the real services and a database that answers
 * DECIMAL columns as Decimal objects:
 *
 *  - the three amounts of a quote are always the lines and the tax added up, whatever is edited (the rate alone, the lines alone,
 *    both, nothing but the title);
 *  - an edit of a quote that was sent keeps the version it replaces and raises the revision; a draft keeps none;
 *  - a question never stands in the way of the answer: the customer (signed in or with the tracking link) can ask, and then accept;
 *  - a customer who says which revision they read is told (409) when the quote was edited since;
 *  - only the artisan of the job (and the staff who handle tickets) write the quote;
 *  - the edit, the cancellation, the sending and the answers are made one after the other on the same job, not mixed.
 */
function desk(options: { status?: string; artisan?: boolean } = {}) {
  const world = emptyWorld();
  const make = (role: string, name: string) => world.memory.plant('user', { role, name });
  const admin = make('ADMIN', 'Admin');
  const dispatcher = make('DISPATCHER', 'Dispatcheur');
  const accountant = make('ACCOUNTANT', 'Comptable');
  const client = make('CLIENT', 'Client');
  const stranger = make('CLIENT', 'Autre client');
  const artisan = make('ARTISAN', 'Artisan');
  const other = make('ARTISAN', 'Autre artisan');

  world.memory.plant('artisanProfile', { userId: artisan.id, verificationStatus: 'APPROVED' });
  world.memory.plant('artisanProfile', { userId: other.id, verificationStatus: 'APPROVED' });

  const token = 'raw-link-0001';
  const job = world.memory.plant('intervention', {
    clientId: client.id,
    artisanId: options.artisan === false ? null : artisan.id,
    status: options.status ?? 'CREATED',
    serviceType: 'PLOMBIER',
    trackingToken: crypto.createHash('sha256').update(token).digest('hex'),
  });

  return { world, admin, dispatcher, accountant, client, stranger, artisan, other, job, token };
}

type Desk = ReturnType<typeof desk>;

const rowsOf = (world: World, model: string) => world.memory.rows(model);
const num = (value: unknown) => Number(String(value));
const quoteRow = (d: Desk, id: number) => rowsOf(d.world, 'quote').find((row) => row.id === id)!;
const itemsOf = (d: Desk, id: number) => rowsOf(d.world, 'quoteItem').filter((row) => row.quoteId === id);
const versionsOf = (d: Desk, id: number) => rowsOf(d.world, 'quoteRevision').filter((row) => row.quoteId === id);
const jobRow = (d: Desk) => rowsOf(d.world, 'intervention').find((row) => row.id === d.job.id)!;
const events = (d: Desk, type?: string) => rowsOf(d.world, 'interventionEvent').filter((row) => row.interventionId === d.job.id && (!type || row.type === type));
const messages = (d: Desk) => rowsOf(d.world, 'message').filter((row) => row.interventionId === d.job.id);
const told = (d: Desk, call: string) => d.world.sink.filter((entry) => entry === call).length;

interface Refusal {
  status: number;
  message: string;
}

async function refusal(work: () => Promise<unknown>): Promise<Refusal | null> {
  try {
    await work();
  } catch (error) {
    const known = error as { getStatus?: () => number; message?: string };

    return { status: typeof known.getStatus === 'function' ? known.getStatus() : 500, message: String(known.message) };
  }

  return null;
}

/** Two lines: 2 x 40.000 and 3 x 4.500, that is 93.500 without tax. */
const LINES = [
  { label: 'Main d’œuvre', quantity: 2, unitPrice: 40 },
  { label: 'Joint', quantity: 3, unitPrice: 4.5 },
];

const quoteDto = (extra: Record<string, unknown> = {}) => ({ title: 'Réparation fuite', description: 'Évier de la cuisine', taxRate: 19, items: LINES, ...extra }) as any;

async function sent(d: Desk, extra: Record<string, unknown> = {}) {
  return d.world.svc.quotes.createForIntervention(d.job.id, d.artisan.id, quoteDto(extra));
}

async function draft(d: Desk, extra: Record<string, unknown> = {}) {
  return d.world.svc.quotes.createDraftForIntervention(d.job.id, d.artisan.id, quoteDto(extra));
}

const edit = (d: Desk, id: number, dto: Record<string, unknown>, by = d.artisan.id) => d.world.svc.quotes.updateQuote(id, by, dto);
const accept = (d: Desk, id: number, dto: Record<string, unknown> = {}) => d.world.svc.quotes.accept(d.client.id, id, dto);
const reject = (d: Desk, id: number, dto: Record<string, unknown> = {}) => d.world.svc.quotes.reject(d.client.id, id, dto);
const change = (d: Desk, id: number, dto: Record<string, unknown> = {}) => d.world.svc.quotes.requestModification(d.client.id, id, dto);
const ask = (d: Desk, id: number, dto: Record<string, unknown> = {}) => d.world.svc.quotes.askQuestion(d.client.id, id, dto);

const asVisitor = {
  accept: (d: Desk, id: number, dto: Record<string, unknown> = {}) => d.world.svc.guest.acceptQuote(d.job.id, id, d.token, dto),
  reject: (d: Desk, id: number, dto: Record<string, unknown> = {}) => d.world.svc.guest.rejectQuote(d.job.id, id, d.token, dto),
  change: (d: Desk, id: number, dto: Record<string, unknown> = {}) => d.world.svc.guest.requestQuoteModification(d.job.id, id, d.token, dto),
  ask: (d: Desk, id: number, dto: Record<string, unknown> = {}) => d.world.svc.guest.askQuoteQuestion(d.job.id, id, d.token, dto),
};

/** What the numbers of a quote must be, worked out here in whole millimes from the lines (quantity x unit price) and the rate. */
function expectedTotals(lines: Array<{ quantity: number; unitPrice: number }>, rate: number) {
  const ht = lines.reduce((sum, line) => sum + Math.round(line.quantity * Math.round(line.unitPrice * 1000)), 0);
  const tax = Math.floor((ht * Math.round(rate * 100) + 5000) / 10000);

  return { amountHT: ht / 1000, taxAmount: tax / 1000, amountTTC: (ht + tax) / 1000 };
}

const amountsOf = (row: Record<string, unknown>) => ({ amountHT: num(row.amountHT), taxAmount: num(row.taxAmount), amountTTC: num(row.amountTTC) });

/** The amounts of a quote add up: the lines make the amount without tax, the tax is the rate of it, the total is the two. */
function expectConsistent(d: Desk, id: number) {
  const row = quoteRow(d, id);
  const items = itemsOf(d, id);
  const wanted = expectedTotals(items.map((item) => ({ quantity: num(item.quantity), unitPrice: num(item.unitPrice) })), num(row.taxRate));

  expect(amountsOf(row)).toEqual(wanted);

  for (const item of items) expect(num(item.total)).toBe(Math.round(num(item.quantity) * Math.round(num(item.unitPrice) * 1000)) / 1000);
}

/** Another request holds the lock of the job; a test decides what it sees meanwhile and what the holder does before it lets go. */
async function whileHolding<T>(world: World, take: (tx: any) => Promise<void>, request: () => Promise<unknown>, midway: () => T, atTheEnd: (tx: any) => Promise<void> = async () => undefined): Promise<{ answer: Refusal | null; seen: T }> {
  let release!: () => void;
  let locked!: () => void;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  const taken = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const holder = world.prisma.$transaction(async (tx: any) => {
    await take(tx);
    locked();
    await open;
    await atTheEnd(tx);
  });

  await taken;

  const waiting = refusal(request);

  await new Promise((resolve) => setTimeout(resolve, 25));

  let seen: T;

  try {
    seen = midway();
  } finally {
    release();
  }

  await holder;

  return { answer: await waiting, seen };
}

describe('the totals of a quote are the lines and the tax added up (P2-04)', () => {
  beforeEach(() => resetLocale());

  it('a quote that is written: 93.500 without tax, 17.765 of tax at 19 %, 111.265 in all', async () => {
    const d = desk();
    const quote = await sent(d);

    expect(amountsOf(quoteRow(d, quote.id))).toEqual({ amountHT: 93.5, taxAmount: 17.765, amountTTC: 111.265 });
    expectConsistent(d, quote.id);
  });

  it('a new rate alone works the amounts out again from the lines already there', async () => {
    const d = desk();
    const quote = await sent(d);

    await edit(d, quote.id, { taxRate: 7 });

    expect(num(quoteRow(d, quote.id).taxRate)).toBe(7);
    expect(amountsOf(quoteRow(d, quote.id))).toEqual({ amountHT: 93.5, taxAmount: 6.545, amountTTC: 100.045 });
    expect(itemsOf(d, quote.id).length).toBe(2);
    expectConsistent(d, quote.id);
  });

  it('a rate or lines that are sent as null are not sent: the quote keeps its own', async () => {
    const d = desk();
    const quote = await sent(d, { taxRate: 7 });

    await edit(d, quote.id, { taxRate: null, items: null, title: 'Autre titre' });

    expect(num(quoteRow(d, quote.id).taxRate)).toBe(7);
    expect(amountsOf(quoteRow(d, quote.id))).toEqual({ amountHT: 93.5, taxAmount: 6.545, amountTTC: 100.045 });
    expect(itemsOf(d, quote.id).length).toBe(2);
    expectConsistent(d, quote.id);
  });

  it('a rate of 0 is a rate: no tax, the total is the amount without tax', async () => {
    const d = desk();
    const quote = await sent(d);

    await edit(d, quote.id, { taxRate: 0 });

    expect(amountsOf(quoteRow(d, quote.id))).toEqual({ amountHT: 93.5, taxAmount: 0, amountTTC: 93.5 });
  });

  it('new lines alone are priced at the rate the quote already has', async () => {
    const d = desk();
    const quote = await sent(d, { taxRate: 7 });

    await edit(d, quote.id, { items: [{ label: 'Robinet', quantity: 1, unitPrice: 120 }] });

    expect(num(quoteRow(d, quote.id).taxRate)).toBe(7);
    expect(amountsOf(quoteRow(d, quote.id))).toEqual({ amountHT: 120, taxAmount: 8.4, amountTTC: 128.4 });
    expect(itemsOf(d, quote.id).map((item) => item.label)).toEqual(['Robinet']);
    expectConsistent(d, quote.id);
  });

  it('new lines and a new rate together', async () => {
    const d = desk();
    const quote = await sent(d);

    await edit(d, quote.id, { taxRate: 13, items: [{ label: 'Siphon', quantity: 4, unitPrice: 12.345 }] });

    expect(amountsOf(quoteRow(d, quote.id))).toEqual(expectedTotals([{ quantity: 4, unitPrice: 12.345 }], 13));
    expect(amountsOf(quoteRow(d, quote.id))).toEqual({ amountHT: 49.38, taxAmount: 6.419, amountTTC: 55.799 });
    expectConsistent(d, quote.id);
  });

  it('a change of the title alone keeps the lines and the amounts as they were', async () => {
    const d = desk();
    const quote = await sent(d);
    const before = amountsOf(quoteRow(d, quote.id));

    await edit(d, quote.id, { title: 'Réparation de la fuite' });

    expect(quoteRow(d, quote.id).title).toBe('Réparation de la fuite');
    expect(amountsOf(quoteRow(d, quote.id))).toEqual(before);
    expect(itemsOf(d, quote.id).length).toBe(2);
  });

  it('a quote whose amounts had drifted from its lines (older data) is put right by the next edit', async () => {
    const d = desk();
    const quote = await sent(d);

    await d.world.prisma.quote.update({ where: { id: quote.id }, data: { amountHT: 50, taxAmount: 1, amountTTC: 51 } });

    expect(amountsOf(quoteRow(d, quote.id)).amountHT).toBe(50);

    await edit(d, quote.id, { description: 'Évier et robinet' });

    expect(amountsOf(quoteRow(d, quote.id))).toEqual({ amountHT: 93.5, taxAmount: 17.765, amountTTC: 111.265 });
    expectConsistent(d, quote.id);
  });

  it('a quote with no line at all (older data) keeps its amount without tax and gets the new tax on it', async () => {
    const d = desk();
    const old = d.world.memory.plant('quote', { interventionId: d.job.id, createdById: d.artisan.id, status: 'SENT', title: 'Ancien devis', amountHT: 200, taxRate: 19, taxAmount: 38, amountTTC: 238, currency: 'TND' });

    await edit(d, old.id, { taxRate: 7 });

    expect(amountsOf(quoteRow(d, old.id))).toEqual({ amountHT: 200, taxAmount: 14, amountTTC: 214 });
    expect(itemsOf(d, old.id)).toEqual([]);
  });

  it('a rate that is not a rate is refused on a quote with no line as well, and its amounts are not touched', async () => {
    const d = desk();
    const old = d.world.memory.plant('quote', { interventionId: d.job.id, createdById: d.artisan.id, status: 'SENT', title: 'Ancien devis', amountHT: 200, taxRate: 19, taxAmount: 38, amountTTC: 238, currency: 'TND' });
    const before = JSON.stringify(quoteRow(d, old.id));

    for (const taxRate of [-1, 101, 19.123, 'dix']) {
      expect((await refusal(() => edit(d, old.id, { taxRate })))?.status).toBe(400);
    }

    expect(JSON.stringify(quoteRow(d, old.id))).toBe(before);
    expect(versionsOf(d, old.id)).toEqual([]);
  });

  it('an empty list of lines is refused, and the quote is not touched', async () => {
    const d = desk();
    const quote = await sent(d);
    const before = JSON.stringify(quoteRow(d, quote.id));
    const answer = await refusal(() => edit(d, quote.id, { items: [] }));

    expect(answer?.status).toBe(400);
    expect(JSON.stringify(quoteRow(d, quote.id))).toBe(before);
    expect(itemsOf(d, quote.id).length).toBe(2);
    expect(versionsOf(d, quote.id)).toEqual([]);
  });

  it('a rate that is not a rate is refused, and nothing is written', async () => {
    const d = desk();
    const quote = await sent(d);
    const before = JSON.stringify(quoteRow(d, quote.id));

    for (const taxRate of [-1, 101, 19.123, 'dix']) {
      const answer = await refusal(() => edit(d, quote.id, { taxRate, title: 'Autre titre' }));

      expect(answer?.status).toBe(400);
    }

    expect(JSON.stringify(quoteRow(d, quote.id))).toBe(before);
    expect(versionsOf(d, quote.id)).toEqual([]);
    expect(events(d, 'STATUS_CHANGED').length).toBe(0);
  });

  it('a line that is not a line is refused, and the old lines stay', async () => {
    const d = desk();
    const quote = await sent(d);

    for (const items of [[{ label: '', quantity: 1, unitPrice: 5 }], [{ label: 'X', quantity: 0, unitPrice: 5 }], [{ label: 'X', quantity: 1, unitPrice: -5 }], [{ label: 'X', quantity: 1 }]]) {
      const answer = await refusal(() => edit(d, quote.id, { items }));

      expect(answer?.status).toBe(400);
    }

    expect(itemsOf(d, quote.id).length).toBe(2);
    expectConsistent(d, quote.id);
  });

  it('a hundred edits in a row, drawn from a fixed sequence: the amounts add up after every one', async () => {
    const d = desk();
    const quote = await sent(d);
    let seed = 20261024;
    const next = (limit: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;

      return seed % limit;
    };
    const rates = [0, 5, 7, 12.5, 13, 19, 20, 33.33];

    for (let step = 0; step < 100; step += 1) {
      const dto: Record<string, unknown> = {};
      const pick = next(4);

      if (pick === 0 || pick === 3) dto.taxRate = rates[next(rates.length)];
      if (pick === 1 || pick === 3) {
        dto.items = Array.from({ length: 1 + next(4) }, (_, at) => ({ label: `Ligne ${at}`, quantity: 1 + next(5), unitPrice: (1 + next(99999)) / 1000 }));
      }
      if (pick === 2) dto.title = `Titre ${step}`;

      await edit(d, quote.id, dto);
      expectConsistent(d, quote.id);
    }

    // The counter went up once for each edit that changed what the customer reads, and every one of them left a version behind.
    expect(num(quoteRow(d, quote.id).revision) - 1).toBe(versionsOf(d, quote.id).length);
  });
});

describe('the versions of a quote (P2-04)', () => {
  beforeEach(() => resetLocale());

  it('a quote that is sent is at revision 1 and has no earlier version', async () => {
    const d = desk();
    const quote = await sent(d);

    expect(num(quoteRow(d, quote.id).revision)).toBe(1);
    expect(versionsOf(d, quote.id)).toEqual([]);
  });

  it('an edit of a quote that was sent keeps the version it replaces and raises the revision', async () => {
    const d = desk();
    const quote = await sent(d);

    await edit(d, quote.id, { taxRate: 7, items: [{ label: 'Robinet', quantity: 1, unitPrice: 120 }] });

    const [kept] = versionsOf(d, quote.id);

    expect(versionsOf(d, quote.id).length).toBe(1);
    expect(num(quoteRow(d, quote.id).revision)).toBe(2);
    expect(kept.revision).toBe(1);
    expect(kept.status).toBe('SENT');
    expect(kept.title).toBe('Réparation fuite');
    expect(kept.description).toBe('Évier de la cuisine');
    expect(kept.currency).toBe('TND');
    expect(amountsOf(kept)).toEqual({ amountHT: 93.5, taxAmount: 17.765, amountTTC: 111.265 });
    expect(num(kept.taxRate)).toBe(19);
    expect(kept.items.map((line: any) => [line.label, line.quantity, line.unitPrice, line.total])).toEqual([
      ['Main d’œuvre', 2, 40, 80],
      ['Joint', 3, 4.5, 13.5],
    ]);
    expect(kept.savedById).toBe(d.artisan.id);
  });

  it('a version keeps the currency the quote was written in', async () => {
    const d = desk();
    const old = d.world.memory.plant('quote', { interventionId: d.job.id, createdById: d.artisan.id, status: 'SENT', title: 'Devis en euros', amountHT: 100, taxRate: 20, taxAmount: 20, amountTTC: 120, currency: 'EUR' });

    d.world.memory.plant('quoteItem', { quoteId: old.id, label: 'Pose', quantity: 1, unitPrice: 100, total: 100 });

    await edit(d, old.id, { title: 'Devis en euros, corrigé' });

    expect(versionsOf(d, old.id).map((row) => [row.revision, row.currency])).toEqual([[1, 'EUR']]);
  });

  it('each edit that changes the quote adds one version, in order, and the latest comes first when they are read', async () => {
    const d = desk();
    const quote = await sent(d);

    await edit(d, quote.id, { title: 'Deuxième' });
    await edit(d, quote.id, { title: 'Troisième' });
    await edit(d, quote.id, { title: 'Quatrième' });

    expect(num(quoteRow(d, quote.id).revision)).toBe(4);
    expect(versionsOf(d, quote.id).map((row) => [row.revision, row.title])).toEqual([
      [1, 'Réparation fuite'],
      [2, 'Deuxième'],
      [3, 'Troisième'],
    ]);

    const read = await d.world.svc.quotes.findRevisions(quote.id, { id: d.admin.id, role: 'ADMIN' });

    expect(read.revision).toBe(4);
    expect(read.revisions.map((row: any) => row.revision)).toEqual([3, 2, 1]);
  });

  it('an edit that changes nothing the customer reads (the same words, the same lines, the same rate) keeps no version', async () => {
    const d = desk();
    const quote = await sent(d);

    await edit(d, quote.id, { title: 'Réparation fuite', description: 'Évier de la cuisine', taxRate: 19, items: LINES });
    await edit(d, quote.id, {});

    expect(num(quoteRow(d, quote.id).revision)).toBe(1);
    expect(versionsOf(d, quote.id)).toEqual([]);
  });

  it('the date it expires is not what the customer reads: it keeps no version', async () => {
    const d = desk();
    const quote = await sent(d);

    await edit(d, quote.id, { expiresAt: '2027-01-01T00:00:00.000Z' });

    expect(new Date(quoteRow(d, quote.id).expiresAt).toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(num(quoteRow(d, quote.id).revision)).toBe(1);
    expect(versionsOf(d, quote.id)).toEqual([]);
  });

  it('the PDF is what the customer downloads: swapping it, adding it or removing it is a change, and the version keeps the PDF it had', async () => {
    const d = desk();
    const quote = await sent(d);

    await edit(d, quote.id, { pdfUrl: 'https://files.example.test/un.pdf' });
    await edit(d, quote.id, { pdfUrl: 'https://files.example.test/un.pdf' });
    await edit(d, quote.id, { pdfUrl: 'https://files.example.test/deux.pdf' });
    await edit(d, quote.id, { pdfUrl: '' });

    expect(num(quoteRow(d, quote.id).revision)).toBe(4);
    expect(versionsOf(d, quote.id).sort((a, b) => num(a.revision) - num(b.revision)).map((row) => [num(row.revision), row.pdfUrl ?? null])).toEqual([
      [1, null],
      [2, 'https://files.example.test/un.pdf'],
      [3, 'https://files.example.test/deux.pdf'],
    ]);
    // A customer who read the quote with the first PDF is told (409).
    expect((await refusal(() => accept(d, quote.id, { revision: 1 })))?.status).toBe(409);
  });

  it('a PDF request with no address (nothing, null, a number) is refused (400) and writes nothing: it is not a PDF swap', async () => {
    const d = desk();
    const quote = await sent(d, { pdfUrl: 'https://files.example.test/un.pdf' });
    const before = JSON.stringify(quoteRow(d, quote.id));

    for (const pdfUrl of [undefined, null, 12]) {
      expect((await refusal(() => d.world.svc.quotes.setPdfUrl(quote.id, pdfUrl as any, d.artisan.id)))?.status).toBe(400);
    }

    expect(JSON.stringify(quoteRow(d, quote.id))).toBe(before);
    expect(versionsOf(d, quote.id)).toEqual([]);
  });

  it('an empty address given to a quote that has no PDF is not a change', async () => {
    const d = desk();
    const quote = await sent(d);

    await edit(d, quote.id, { pdfUrl: '' });
    await d.world.svc.quotes.setPdfUrl(quote.id, '', d.artisan.id);
    await d.world.svc.quotes.setPdfUrl(quote.id, '   ', d.artisan.id);

    expect(num(quoteRow(d, quote.id).revision)).toBe(1);
    expect(versionsOf(d, quote.id)).toEqual([]);
  });

  it('the PDF of a draft is nobody\'s yet: it keeps no version', async () => {
    const d = desk();
    const quote = await draft(d);

    await edit(d, quote.id, { pdfUrl: 'https://files.example.test/un.pdf' });
    await d.world.svc.quotes.setPdfUrl(quote.id, 'https://files.example.test/deux.pdf', d.artisan.id);

    expect(quoteRow(d, quote.id).pdfUrl).toBe('https://files.example.test/deux.pdf');
    expect(num(quoteRow(d, quote.id).revision)).toBe(1);
    expect(versionsOf(d, quote.id)).toEqual([]);
  });

  it('the PDF attached by the PDF route is an edit like the others: it keeps the version, with who did it (or nobody for the system)', async () => {
    const d = desk();
    const quote = await sent(d);

    await d.world.svc.quotes.setPdfUrl(quote.id, 'https://files.example.test/un.pdf', d.artisan.id);
    await d.world.svc.quotes.setPdfUrl(quote.id, 'https://files.example.test/un.pdf', d.artisan.id);
    await d.world.svc.quotes.setPdfUrl(quote.id, 'https://files.example.test/deux.pdf');

    expect(num(quoteRow(d, quote.id).revision)).toBe(3);
    expect(versionsOf(d, quote.id).sort((a, b) => num(a.revision) - num(b.revision)).map((row) => [num(row.revision), row.pdfUrl ?? null, row.savedById ?? null])).toEqual([
      [1, null, d.artisan.id],
      [2, 'https://files.example.test/un.pdf', null],
    ]);
  });

  it('each of the title, the description, the rate and a line alone counts as a change', async () => {
    const d = desk();
    const quote = await sent(d);
    const edits: Array<Record<string, unknown>> = [
      { title: 'Autre titre' },
      { description: 'Autre description' },
      { taxRate: 13 },
      { items: [{ label: 'Main d’œuvre', quantity: 2, unitPrice: 40 }, { label: 'Joint', quantity: 3, unitPrice: 5 }] },
      { items: [{ label: 'Main d’œuvre', quantity: 2, unitPrice: 40 }, { label: 'Joint', quantity: 4, unitPrice: 5 }] },
      { items: [{ label: 'Main d’œuvre', description: 'Avec le déplacement', quantity: 2, unitPrice: 40 }, { label: 'Joint', quantity: 4, unitPrice: 5 }] },
    ];

    for (const [at, dto] of edits.entries()) {
      await edit(d, quote.id, dto);

      expect(num(quoteRow(d, quote.id).revision)).toBe(at + 2);
    }

    expect(versionsOf(d, quote.id).length).toBe(edits.length);
  });

  it('a title given as null is a title not sent: the quote keeps its title and nothing is raised', async () => {
    const d = desk();
    const quote = await sent(d);

    await edit(d, quote.id, { title: null });

    expect(quoteRow(d, quote.id).title).toBe('Réparation fuite');
    expect(num(quoteRow(d, quote.id).revision)).toBe(1);
    expect(versionsOf(d, quote.id)).toEqual([]);
  });

  it('a rate is a change even when the amounts do not move (a quote of one millime, whose tax is under a millime at either rate)', async () => {
    const d = desk();
    const quote = await sent(d, { items: [{ label: 'Vis', quantity: 1, unitPrice: 0.001 }] });
    const before = amountsOf(quoteRow(d, quote.id));

    await edit(d, quote.id, { taxRate: 7 });

    expect(amountsOf(quoteRow(d, quote.id))).toEqual(before);
    expect(num(quoteRow(d, quote.id).taxRate)).toBe(7);
    expect(num(quoteRow(d, quote.id).revision)).toBe(2);
    expect(versionsOf(d, quote.id).map((row) => num(row.taxRate))).toEqual([19]);
  });

  it('a description that is emptied is a change, and an empty description given to a quote that has none is not', async () => {
    const d = desk();
    const quote = await sent(d);

    await edit(d, quote.id, { description: '' });
    expect(num(quoteRow(d, quote.id).revision)).toBe(2);

    await edit(d, quote.id, { description: '   ' });
    expect(num(quoteRow(d, quote.id).revision)).toBe(2);
  });

  it('a draft is not seen by anyone: editing it keeps no version, and the revision stays at 1', async () => {
    const d = desk();
    const quote = await draft(d);

    await edit(d, quote.id, { title: 'Brouillon 2' });
    await edit(d, quote.id, { taxRate: 7 });
    await edit(d, quote.id, { items: [{ label: 'Robinet', quantity: 1, unitPrice: 120 }] });

    expect(num(quoteRow(d, quote.id).revision)).toBe(1);
    expect(versionsOf(d, quote.id)).toEqual([]);
    expectConsistent(d, quote.id);
  });

  it('a quote that was drafted, then sent, then edited is at revision 2 with the sent version kept', async () => {
    const d = desk();
    const quote = await draft(d);

    await edit(d, quote.id, { title: 'Brouillon 2' });
    await d.world.svc.quotes.sendQuote(quote.id, d.artisan.id);
    await edit(d, quote.id, { title: 'Envoyé 2' });

    expect(num(quoteRow(d, quote.id).revision)).toBe(2);
    expect(versionsOf(d, quote.id).map((row) => [row.revision, row.status, row.title])).toEqual([[1, 'SENT', 'Brouillon 2']]);
  });

  it('a quote the customer asked to change is edited with its version kept (and is sent again as it is)', async () => {
    const d = desk();
    const quote = await sent(d);

    await change(d, quote.id, { note: 'Moins cher ?' });
    await edit(d, quote.id, { items: [{ label: 'Main d’œuvre', quantity: 2, unitPrice: 35 }, { label: 'Joint', quantity: 3, unitPrice: 4.5 }] });

    expect(quoteRow(d, quote.id).status).toBe('MODIFICATION_REQUESTED');
    expect(versionsOf(d, quote.id).map((row) => [row.revision, row.status])).toEqual([[1, 'MODIFICATION_REQUESTED']]);
    expect(num(quoteRow(d, quote.id).revision)).toBe(2);

    await d.world.svc.quotes.sendQuote(quote.id, d.artisan.id);

    expect(quoteRow(d, quote.id).status).toBe('SENT');
    expect(num(quoteRow(d, quote.id).revision)).toBe(2);
  });

  it('an accepted, refused, cancelled or expired quote cannot be edited, and keeps no version', async () => {
    for (const how of ['accept', 'reject', 'cancel', 'expire'] as const) {
      const d = desk();
      const quote = await sent(d);

      if (how === 'accept') await accept(d, quote.id);
      if (how === 'reject') await reject(d, quote.id);
      if (how === 'cancel') await d.world.svc.quotes.cancelQuote(quote.id, d.artisan.id);
      if (how === 'expire') await d.world.svc.quotes.expireQuote(quote.id, d.admin.id);

      const answer = await refusal(() => edit(d, quote.id, { title: 'Trop tard' }));

      expect(answer?.status).toBe(400);
      expect(quoteRow(d, quote.id).title).toBe('Réparation fuite');
      expect(versionsOf(d, quote.id)).toEqual([]);
    }
  });

  it('the versions of a quote are its own: the edits of another quote of the job are not among them', async () => {
    const d = desk();
    const first = await sent(d, { title: 'Premier' });
    const second = await sent(d, { title: 'Deuxième' });

    await edit(d, first.id, { title: 'Premier bis' });
    await edit(d, second.id, { title: 'Deuxième bis' });
    await edit(d, second.id, { title: 'Deuxième ter' });

    const read = await d.world.svc.quotes.findRevisions(first.id, { id: d.admin.id, role: 'ADMIN' });

    expect(read.revisions.map((row: any) => [row.quoteId, row.title])).toEqual([[first.id, 'Premier']]);
    expect(versionsOf(d, second.id).length).toBe(2);
  });

  it('a quote cannot have two versions with the same number', async () => {
    const d = desk();
    const quote = await sent(d);

    await edit(d, quote.id, { title: 'Deuxième' });

    const again = () => d.world.prisma.quoteRevision.create({ data: { quoteId: quote.id, revision: 1, status: 'SENT', title: 'Doublon', amountHT: 1, taxRate: 19, taxAmount: 0.19, amountTTC: 1.19, items: [] } });

    expect((await refusal(again))?.status).toBe(500);
    expect(versionsOf(d, quote.id).length).toBe(1);
  });

  it('the edit is told on the timeline with the revision it made and whether the content changed', async () => {
    const d = desk();
    const quote = await sent(d);

    await edit(d, quote.id, { title: 'Autre titre' });
    await edit(d, quote.id, { title: 'Autre titre' });

    const updates = events(d, 'STATUS_CHANGED').filter((event) => event.title === 'Devis mis à jour');

    expect(updates.map((event) => [event.metadata.revision, event.metadata.contentChanged])).toEqual([
      [2, true],
      [2, false],
    ]);
  });

  it('the edit of a draft is not on the timeline, which the customer reads: nobody has seen the draft', async () => {
    const d = desk();
    const quote = await draft(d);

    await edit(d, quote.id, { title: 'Autre titre' });

    expect(events(d).filter((event) => event.title === 'Devis mis à jour')).toEqual([]);

    await d.world.svc.quotes.sendQuote(quote.id, d.artisan.id);
    await edit(d, quote.id, { title: 'Encore un autre' });

    expect(events(d).filter((event) => event.title === 'Devis mis à jour').length).toBe(1);
  });
});

describe('sending, cancelling and expiring a quote (P2-04)', () => {
  beforeEach(() => resetLocale());

  it('a draft whose date has passed cannot be sent', async () => {
    const d = desk();
    const quote = await draft(d);

    // the date passes while the draft waits (nobody can make a quote that is born expired: see the test on the dates)
    quoteRow(d, quote.id).expiresAt = new Date('2020-01-01T00:00:00.000Z');

    const answer = await refusal(() => d.world.svc.quotes.sendQuote(quote.id, d.artisan.id));

    expect(answer?.status).toBe(400);
    expect(answer?.message).toBe('Ce devis a expiré.');
    expect(quoteRow(d, quote.id).status).toBe('DRAFT');
    expect(events(d, 'QUOTE_SENT')).toEqual([]);
  });

  it('a date of validity that has already passed is refused: a quote cannot be born expired (a phone with a wrong clock)', async () => {
    const past = '2020-01-01T00:00:00.000Z';
    const words = 'La date de fin de validité du devis est déjà passée: vérifiez la date de votre téléphone.';

    for (const how of ['send', 'draft', 'edit', 'edit a draft', 'send garbage', 'edit garbage'] as const) {
      const d = desk();
      const before = rowsOf(d.world, 'quote').length;
      const made = how === 'edit' || how === 'edit garbage' ? await sent(d) : how === 'edit a draft' ? await draft(d) : null;
      const count = rowsOf(d.world, 'quote').length;
      const answer = await refusal(() =>
        how === 'send'
          ? sent(d, { expiresAt: past })
          : how === 'draft'
            ? draft(d, { expiresAt: past })
            : how === 'send garbage'
              ? sent(d, { expiresAt: 'not a date' })
              : how === 'edit garbage'
                ? edit(d, made!.id, { expiresAt: 'not a date' })
                : edit(d, made!.id, { expiresAt: past }),
      );

      expect(`${how}: ${answer?.status} ${answer?.message}`).toBe(`${how}: 400 ${words}`);
      expect(`${how}: ${rowsOf(d.world, 'quote').length}`).toBe(`${how}: ${how === 'send' || how === 'draft' || how === 'send garbage' ? before : count}`);

      if (made) expect(quoteRow(d, made.id).expiresAt ?? null).toBe(null);
    }
  });

  it('a date that passed a minute, an hour, a day or a month ago is as refused as one from years ago, and one a minute ahead is taken', async () => {
    const words = 'La date de fin de validité du devis est déjà passée: vérifiez la date de votre téléphone.';

    for (const ago of [1_000, 60_000, 3_600_000, 86_400_000, 30 * 86_400_000, 399 * 86_400_000]) {
      const d = desk();
      const answer = await refusal(() => sent(d, { expiresAt: new Date(Date.now() - ago).toISOString() }));

      expect(`${ago}: ${answer?.status} ${answer?.message}`).toBe(`${ago}: 400 ${words}`);
      expect(rowsOf(d.world, 'quote')).toHaveLength(0);
    }

    const d = desk();
    const ahead = new Date(Date.now() + 60_000).toISOString();
    const quote = await sent(d, { expiresAt: ahead });

    expect(new Date(quoteRow(d, quote.id).expiresAt).toISOString()).toBe(ahead);
  });

  it('a date of validity in the future, and no date at all, are taken', async () => {
    const d = desk();
    const soon = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const withDate = await sent(d, { expiresAt: soon });
    const without = await draft(d);

    expect(new Date(quoteRow(d, withDate.id).expiresAt).toISOString()).toBe(soon);
    expect(quoteRow(d, without.id).expiresAt ?? null).toBe(null);
    expect(await refusal(() => edit(d, without.id, { expiresAt: soon }))).toBe(null);
  });

  it('only a draft or a quote to modify is sent', async () => {
    for (const how of ['sent', 'accept', 'reject', 'cancel'] as const) {
      const d = desk();
      const quote = await sent(d);

      if (how === 'accept') await accept(d, quote.id);
      if (how === 'reject') await reject(d, quote.id);
      if (how === 'cancel') await d.world.svc.quotes.cancelQuote(quote.id, d.artisan.id);

      const status = quoteRow(d, quote.id).status;
      const answer = await refusal(() => d.world.svc.quotes.sendQuote(quote.id, d.artisan.id));

      expect(answer?.status).toBe(400);
      expect(quoteRow(d, quote.id).status).toBe(status);
    }
  });

  it('a quote is cancelled once: the second cancellation is turned away and tells nothing', async () => {
    const d = desk();
    const quote = await sent(d);

    await d.world.svc.quotes.cancelQuote(quote.id, d.artisan.id, { note: 'Erreur de prix' });

    const answer = await refusal(() => d.world.svc.quotes.cancelQuote(quote.id, d.admin.id));

    expect(answer?.status).toBe(400);
    expect(quoteRow(d, quote.id).clientNote).toBe('Erreur de prix');
    expect(events(d, 'CANCELLED').length).toBe(1);
  });

  it('a quote that was accepted cannot be cancelled', async () => {
    const d = desk();
    const quote = await sent(d);

    await accept(d, quote.id);

    expect((await refusal(() => d.world.svc.quotes.cancelQuote(quote.id, d.artisan.id)))?.status).toBe(400);
    expect(quoteRow(d, quote.id).status).toBe('ACCEPTED');
  });

  it('a quote that is decided is not expired afterwards, and one that waits is', async () => {
    for (const how of ['accept', 'reject', 'cancel', 'expire'] as const) {
      const d = desk();
      const quote = await sent(d);

      if (how === 'accept') await accept(d, quote.id);
      if (how === 'reject') await reject(d, quote.id);
      if (how === 'cancel') await d.world.svc.quotes.cancelQuote(quote.id, d.artisan.id);
      if (how === 'expire') await d.world.svc.quotes.expireQuote(quote.id, d.admin.id);

      const status = quoteRow(d, quote.id).status;

      expect((await refusal(() => d.world.svc.quotes.expireQuote(quote.id, d.admin.id)))?.status).toBe(400);
      expect(quoteRow(d, quote.id).status).toBe(status);
    }

    const waiting = desk();
    const quote = await sent(waiting);

    await change(waiting, quote.id, { note: 'Autre prix' });
    await waiting.world.svc.quotes.expireQuote(quote.id, waiting.admin.id);

    expect(quoteRow(waiting, quote.id).status).toBe('EXPIRED');
    expect(quoteRow(waiting, quote.id).expiredAt).not.toBe(null);
  });
});

describe('who reads the versions of a quote (P2-04)', () => {
  beforeEach(() => resetLocale());

  async function edited() {
    const d = desk();
    const quote = await sent(d);

    await edit(d, quote.id, { title: 'Deuxième' });

    return { d, quote };
  }

  it('the artisan of the job reads them, without the name of who made each edit', async () => {
    const { d, quote } = await edited();
    const read = await d.world.svc.quotes.findRevisions(quote.id, { id: d.artisan.id, role: 'ARTISAN' });

    expect(read.quoteId).toBe(quote.id);
    expect(read.revision).toBe(2);
    expect(read.revisions.length).toBe(1);
    expect(read.revisions[0].title).toBe('Réparation fuite');
    expect(read.revisions[0]).not.toHaveProperty('savedById');
    expect(read.revisions[0].items.length).toBe(2);
  });

  it('a version holds what the quote held, and nothing else', async () => {
    const { d, quote } = await edited();
    const read = await d.world.svc.quotes.findRevisions(quote.id, { id: d.artisan.id, role: 'ARTISAN' });

    expect(Object.keys(read).sort()).toEqual(['quoteId', 'revision', 'revisions']);
    expect(Object.keys(read.revisions[0]).sort()).toEqual(['amountHT', 'amountTTC', 'currency', 'description', 'id', 'items', 'pdfUrl', 'quoteId', 'revision', 'savedAt', 'status', 'taxAmount', 'taxRate', 'title']);
    expect(Object.keys(read.revisions[0].items[0]).sort()).toEqual(['description', 'label', 'quantity', 'total', 'unitPrice']);
  });

  it('a line of a version shows its five fields and nothing else that the stored lines may hold', async () => {
    const d = desk();
    const quote = await sent(d);

    d.world.memory.plant('quoteRevision', {
      quoteId: quote.id,
      revision: 1,
      status: 'SENT',
      title: 'Version ancienne',
      amountHT: 10,
      taxRate: 19,
      taxAmount: 1.9,
      amountTTC: 11.9,
      items: [{ label: 'Pose', description: null, quantity: 1, unitPrice: 10, total: 10, internalNote: 'marge 40 %' }],
    });

    for (const [person, role] of [[d.artisan, 'ARTISAN'], [d.admin, 'ADMIN']] as const) {
      const read = await d.world.svc.quotes.findRevisions(quote.id, { id: person.id, role });

      expect(JSON.stringify(read)).not.toContain('marge');
      expect(read.revisions[0].items).toEqual([{ label: 'Pose', description: null, quantity: 1, unitPrice: 10, total: 10 }]);
    }
  });

  it('the back office reads them, with who made each edit', async () => {
    const { d, quote } = await edited();

    for (const [person, role] of [[d.admin, 'ADMIN'], [d.dispatcher, 'DISPATCHER'], [d.accountant, 'ACCOUNTANT']] as const) {
      const read = await d.world.svc.quotes.findRevisions(quote.id, { id: person.id, role });

      expect(read.revisions[0].savedById).toBe(d.artisan.id);
    }
  });

  it('another artisan, and the customer, are told the quote does not exist', async () => {
    const { d, quote } = await edited();

    for (const [person, role] of [[d.other, 'ARTISAN'], [d.client, 'CLIENT'], [d.stranger, 'CLIENT']] as const) {
      const answer = await refusal(() => d.world.svc.quotes.findRevisions(quote.id, { id: person.id, role }));

      expect(answer?.status).toBe(404);
    }
  });

  it('an artisan does not read the versions of a draft that somebody else wrote', async () => {
    const d = desk();
    const quote = await d.world.svc.quotes.createDraftForIntervention(d.job.id, d.admin.id, quoteDto());
    const answer = await refusal(() => d.world.svc.quotes.findRevisions(quote.id, { id: d.artisan.id, role: 'ARTISAN' }));

    expect(answer?.status).toBe(404);
  });

  it('the customer never gets the revisions in the quote as they read it, only the number', async () => {
    const { d, quote } = await edited();
    const read: any[] = await d.world.svc.quotes.findForClient(d.client.id, d.job.id);

    expect(read[0].revision).toBe(2);
    expect(read[0]).not.toHaveProperty('revisions');
    expect(JSON.stringify(read)).not.toContain('Réparation fuite');
    expect(quote.id).toBe(read[0].id);
  });
});

describe('who writes a quote (P2-04: only the assigned artisan, or the staff who handle tickets)', () => {
  beforeEach(() => resetLocale());

  it('the assigned artisan and the staff create, edit, send and cancel', async () => {
    const d = desk();
    const quote = await draft(d);

    await edit(d, quote.id, { title: 'Par l’artisan' }, d.artisan.id);
    await edit(d, quote.id, { title: 'Par l’admin' }, d.admin.id);
    await edit(d, quote.id, { title: 'Par le dispatcheur' }, d.dispatcher.id);
    await d.world.svc.quotes.sendQuote(quote.id, d.dispatcher.id);

    expect(quoteRow(d, quote.id).status).toBe('SENT');

    await d.world.svc.quotes.cancelQuote(quote.id, d.artisan.id);

    expect(quoteRow(d, quote.id).status).toBe('CANCELLED');
  });

  it('another artisan, the customer and the accountant are refused (403), whatever they do to the quote', async () => {
    const d = desk();
    const quote = await sent(d);
    const before = JSON.stringify(quoteRow(d, quote.id));

    for (const person of [d.other, d.client, d.accountant]) {
      expect((await refusal(() => edit(d, quote.id, { title: 'Pirate' }, person.id)))?.status).toBe(403);
      expect((await refusal(() => d.world.svc.quotes.cancelQuote(quote.id, person.id)))?.status).toBe(403);
      expect((await refusal(() => d.world.svc.quotes.sendQuote(quote.id, person.id)))?.status).toBe(403);
      expect((await refusal(() => d.world.svc.quotes.createForIntervention(d.job.id, person.id, quoteDto())))?.status).toBe(403);
      expect((await refusal(() => d.world.svc.quotes.createDraftForIntervention(d.job.id, person.id, quoteDto())))?.status).toBe(403);
    }

    expect(JSON.stringify(quoteRow(d, quote.id))).toBe(before);
    expect(versionsOf(d, quote.id)).toEqual([]);
    expect(rowsOf(d.world, 'quote').length).toBe(1);
  });

  it('a job that was given to another artisan is no longer the first one\'s: the old artisan is refused, the new one writes', async () => {
    const d = desk();
    const quote = await sent(d);

    await d.world.prisma.intervention.update({ where: { id: d.job.id }, data: { artisanId: d.other.id } });

    expect((await refusal(() => edit(d, quote.id, { title: 'Ancien' }, d.artisan.id)))?.status).toBe(403);

    await edit(d, quote.id, { title: 'Nouveau' }, d.other.id);

    expect(quoteRow(d, quote.id).title).toBe('Nouveau');
    expect(versionsOf(d, quote.id)[0].savedById).toBe(d.other.id);
  });

  it('a job that has no artisan yet: only the staff write the quote', async () => {
    const d = desk({ artisan: false });

    expect((await refusal(() => d.world.svc.quotes.createForIntervention(d.job.id, d.artisan.id, quoteDto())))?.status).toBe(403);

    const quote = await d.world.svc.quotes.createForIntervention(d.job.id, d.admin.id, quoteDto());

    expect((await refusal(() => edit(d, quote.id, { title: 'Pirate' }, d.artisan.id)))?.status).toBe(403);

    await edit(d, quote.id, { title: 'Équipe' }, d.admin.id);

    expect(quoteRow(d, quote.id).title).toBe('Équipe');
  });

  it('a person who does not exist, or a job that does not exist, is told so (404)', async () => {
    const d = desk();
    const quote = await sent(d);

    expect((await refusal(() => edit(d, quote.id, { title: 'X' }, 99999)))?.status).toBe(404);
    expect((await refusal(() => d.world.svc.quotes.createForIntervention(99999, d.admin.id, quoteDto())))?.status).toBe(404);
    expect((await refusal(() => edit(d, 99999, { title: 'X' })))?.status).toBe(404);
  });
});

describe('the doors of the routes this change adds (P2-04)', () => {
  it('the versions of a quote: the five staff roles and the artisans pass the door, nobody else', () => {
    const route = emptyWorld().router.route('GET /quotes/:/revisions');

    expect(route.how).toBe('roles');
    expect([...route.roles].sort()).toEqual(['ACCOUNTANT', 'ADMIN', 'ARTISAN', 'DISPATCHER', 'SUPER_ADMIN', 'SUPPORT']);
    expect(route.guards).toEqual(['JwtAuthGuard', 'RolesGuard']);
  });

  it('the question of a visitor is opened by the tracking link like the other answers, and by nothing else', () => {
    const world = emptyWorld();
    const question = world.router.route('POST /guest/interventions/:/quotes/:/question');

    for (const answer of ['accept', 'reject', 'request-modification']) {
      const other = world.router.route(`POST /guest/interventions/:/quotes/:/${answer}`);

      expect([question.how, question.roles, question.guards]).toEqual([other.how, other.roles, other.guards]);
    }
  });
});

describe('a question never stands in the way of the answer (P2-04)', () => {
  beforeEach(() => resetLocale());

  it('the customer asks, the quote stays as it was sent, the question is kept and told, and the customer can accept it', async () => {
    const d = desk();
    const quote = await sent(d);
    const asked: any = await ask(d, quote.id, { note: 'Le joint est-il compris ?' });

    expect(asked.status).toBe('SENT');
    expect(quoteRow(d, quote.id).status).toBe('SENT');
    expect(quoteRow(d, quote.id).clientNote).toBe('Le joint est-il compris ?');
    expect(messages(d).map((row) => [row.audience, row.senderId, row.content])).toEqual([['CLIENT_SUPPORT', d.client.id, `Question sur le devis #${quote.id}: Le joint est-il compris ?`]]);
    expect(events(d, 'QUOTE_MODIFICATION_REQUESTED').map((event) => [event.title, event.metadata.question, event.metadata.quoteId])).toEqual([['Question sur le devis', true, quote.id]]);
    expect(jobRow(d).status).toBe('QUOTE_SENT');

    const answer: any = await accept(d, quote.id, { note: 'Merci, d’accord' });

    expect(answer.status).toBe('ACCEPTED');
    expect(quoteRow(d, quote.id).status).toBe('ACCEPTED');
    expect(quoteRow(d, quote.id).clientNote).toBe('Merci, d’accord');
    expect(events(d, 'QUOTE_ACCEPTED').map((event) => event.message)).toEqual(['Merci, d’accord']);
    expect(jobRow(d).status).toBe('QUOTE_ACCEPTED');
  });

  it('several questions in a row, and the acceptance still goes through', async () => {
    const d = desk();
    const quote = await sent(d);

    await ask(d, quote.id, { note: 'Première' });
    await ask(d, quote.id, { note: 'Deuxième' });
    await ask(d, quote.id, {});

    expect(quoteRow(d, quote.id).status).toBe('SENT');
    expect(quoteRow(d, quote.id).clientNote).toBe('Deuxième');
    expect(messages(d).length).toBe(3);
    expect(messages(d)[2].content).toBe(`Question sur le devis #${quote.id}: Le client demande des précisions sur le devis.`);

    await accept(d, quote.id);

    expect(quoteRow(d, quote.id).status).toBe('ACCEPTED');
  });

  it('a request for a change holds the acceptance until the artisan sends the quote again: the customer and the visitor are told so (400), and nothing moves', async () => {
    const d = desk();
    const quote = await sent(d);

    await change(d, quote.id, { note: 'Moins cher ?' });

    for (const act of [accept, asVisitor.accept]) {
      const answer = await refusal(() => act(d, quote.id, { note: 'Tant pis' }));

      expect(answer?.status).toBe(400);
      expect(answer?.message).toBe('L’artisan est en train de modifier ce devis: vous pourrez l’accepter dès qu’il vous sera renvoyé.');
    }

    expect(quoteRow(d, quote.id).status).toBe('MODIFICATION_REQUESTED');
    expect(quoteRow(d, quote.id).clientNote).toBe('Moins cher ?');
    expect(quoteRow(d, quote.id).acceptedAt ?? null).toBe(null);
    expect(jobRow(d).status).toBe('QUOTE_SENT');
    expect(events(d, 'QUOTE_ACCEPTED')).toEqual([]);
    expect(told(d, 'notifications.notifyQuoteAccepted')).toBe(0);
  });

  it('the acceptance goes through once the artisan has edited the quote and sent it again, for the revision that was sent', async () => {
    for (const by of [accept, asVisitor.accept]) {
      const d = desk();
      const quote = await sent(d);

      await change(d, quote.id, { note: 'Moins cher ?' });
      await edit(d, quote.id, { items: [{ label: 'Main d’œuvre', quantity: 2, unitPrice: 35 }, { label: 'Joint', quantity: 3, unitPrice: 4.5 }] });

      expect((await refusal(() => by(d, quote.id)))?.status).toBe(400);

      await d.world.svc.quotes.sendQuote(quote.id, d.artisan.id);

      expect((await refusal(() => by(d, quote.id, { revision: 1 })))?.status).toBe(409);

      await by(d, quote.id, { revision: 2 });

      expect(quoteRow(d, quote.id).status).toBe('ACCEPTED');
      expect(jobRow(d).status).toBe('QUOTE_ACCEPTED');
      expect(events(d, 'QUOTE_ACCEPTED').map((event) => event.metadata.revision)).toEqual([2]);
    }
  });

  it('a request for a change leaves the customer the other answers: refuse the quote, ask more, ask again for another change', async () => {
    for (const [name, who] of [['the customer', { reject, change, ask }], ['the visitor', asVisitor]] as const) {
      const d = desk();
      const quote = await sent(d);

      await who.change(d, quote.id, { note: 'Moins cher ?' });
      await who.ask(d, quote.id, { note: 'Et le joint ?' });
      await who.change(d, quote.id, { note: 'Plutôt 80 TND' });

      expect([name, quoteRow(d, quote.id).status]).toEqual([name, 'MODIFICATION_REQUESTED']);
      expect([name, quoteRow(d, quote.id).clientNote]).toEqual([name, 'Plutôt 80 TND']);

      await who.reject(d, quote.id, { note: 'Finalement non' });

      expect([name, quoteRow(d, quote.id).status]).toEqual([name, 'REJECTED']);
      expect(quoteRow(d, quote.id).rejectedAt).not.toBe(null);
    }
  });

  it('a second request for a change with no words (a double tap, a retry) keeps the first one; with words it replaces it', async () => {
    for (const who of [{ change }, { change: asVisitor.change }]) {
      const d = desk();
      const quote = await sent(d);

      await who.change(d, quote.id, { note: 'Moins cher ?' });
      await who.change(d, quote.id, {});

      expect(quoteRow(d, quote.id).status).toBe('MODIFICATION_REQUESTED');
      expect(quoteRow(d, quote.id).clientNote).toBe('Moins cher ?');
      expect(messages(d).length).toBe(2);

      await who.change(d, quote.id, { note: 'Plutôt 80 TND' });

      expect(quoteRow(d, quote.id).clientNote).toBe('Plutôt 80 TND');
    }
  });

  it('a first request for a change with no words replaces an earlier question as the note of the quote', async () => {
    const d = desk();
    const quote = await sent(d);

    await ask(d, quote.id, { note: 'Une question' });
    await change(d, quote.id, {});

    expect(quoteRow(d, quote.id).status).toBe('MODIFICATION_REQUESTED');
    expect(quoteRow(d, quote.id).clientNote ?? null).toBe(null);
  });

  it('a request for a change keeps the note, tells the support with a message, and goes on the timeline', async () => {
    const d = desk();
    const quote = await sent(d);

    await change(d, quote.id, { note: 'Moins cher ?' });

    expect(quoteRow(d, quote.id).clientNote).toBe('Moins cher ?');
    expect(messages(d).map((row) => [row.audience, row.senderId, row.content])).toEqual([['CLIENT_SUPPORT', d.client.id, `Question / demande sur le devis #${quote.id}: Moins cher ?`]]);
    expect(events(d, 'QUOTE_MODIFICATION_REQUESTED').map((event) => [event.title, event.metadata.question ?? false])).toEqual([['Modification du devis demandée', false]]);
  });

  it('a refusal keeps the note and the date', async () => {
    const d = desk();
    const quote = await sent(d);

    await reject(d, quote.id, { note: 'Trop cher' });

    expect(quoteRow(d, quote.id).status).toBe('REJECTED');
    expect(quoteRow(d, quote.id).clientNote).toBe('Trop cher');
    expect(quoteRow(d, quote.id).rejectedAt).not.toBe(null);
    expect(events(d, 'QUOTE_REJECTED').length).toBe(1);
  });

  it('each answer returns the quote as the customer reads it, with its lines', async () => {
    const d = desk();
    const answers: any[] = [];

    for (const act of [ask, change, reject]) answers.push(await act(d, (await sent(d)).id, { note: 'x' }));

    answers.push(await accept(d, (await sent(d)).id, { note: 'x' }));

    for (const act of [asVisitor.ask, asVisitor.change, asVisitor.reject]) answers.push(await act(d, (await sent(d)).id, { note: 'x' }));

    answers.push(await asVisitor.accept(d, (await sent(d)).id, { note: 'x' }));

    expect(answers.map((answer) => answer.status)).toEqual(['SENT', 'MODIFICATION_REQUESTED', 'REJECTED', 'ACCEPTED', 'SENT', 'MODIFICATION_REQUESTED', 'REJECTED', 'ACCEPTED']);

    for (const answer of answers) {
      expect(answer.items.map((line: any) => line.label)).toEqual(['Main d’œuvre', 'Joint']);
      expect(answer).not.toHaveProperty('createdBy');
    }
  });

  it('what the visitor does is told on the timeline as what it is', async () => {
    const d = desk();
    const refused = await sent(d);
    const changed = await sent(d);

    await asVisitor.reject(d, refused.id, { note: 'Non' });
    await asVisitor.change(d, changed.id, { note: 'Moins cher' });

    expect(events(d, 'QUOTE_REJECTED').map((event) => [event.title, event.message, event.metadata?.quoteId ?? null])).toEqual([['Devis refusé', 'Non', refused.id]]);
    expect(events(d, 'QUOTE_MODIFICATION_REQUESTED').map((event) => [event.title, event.message, event.metadata?.quoteId ?? null])).toEqual([['Modification du devis demandée', 'Moins cher', changed.id]]);
    expect(quoteRow(d, refused.id).rejectedAt).not.toBe(null);
    // The request of the visitor reaches the support as a message, like the one of the signed-in customer.
    expect(messages(d).map((row) => [row.audience, row.senderId, row.content])).toEqual([['CLIENT_SUPPORT', d.client.id, `Question / demande sur le devis #${changed.id}: Moins cher`]]);
  });

  it('what each answer says when the quote is no longer waiting for one', async () => {
    const d = desk();
    const quote = await sent(d);

    await accept(d, quote.id);

    const words = async (act: (d: Desk, id: number, dto?: Record<string, unknown>) => Promise<unknown>) => (await refusal(() => act(d, quote.id, { note: 'x' })))?.message;

    expect(await words(accept)).toBe('Ce devis ne peut plus être accepté.');
    expect(await words(reject)).toBe('Ce devis ne peut plus être refusé.');
    expect(await words(change)).toBe('Vous pouvez demander une modification uniquement sur un devis envoyé.');
    expect(await words(ask)).toBe('Vous pouvez poser une question uniquement sur un devis envoyé.');
    expect(await words(asVisitor.accept)).toBe('Ce devis ne peut plus être accepté.');
    expect(await words(asVisitor.reject)).toBe('Ce devis ne peut plus être refusé.');
    expect(await words(asVisitor.change)).toBe('Vous pouvez demander une modification uniquement sur un devis envoyé.');
    expect(await words(asVisitor.ask)).toBe('Vous pouvez poser une question uniquement sur un devis envoyé.');
  });

  it('a question asked about a quote that waits for a change leaves it waiting for the change', async () => {
    const d = desk();
    const quote = await sent(d);

    await change(d, quote.id, { note: 'Moins cher ?' });
    await ask(d, quote.id, { note: 'Et le joint ?' });

    expect(quoteRow(d, quote.id).status).toBe('MODIFICATION_REQUESTED');
    // The note the quote holds is the request that the artisan has to act on: the question is on the messages and on the timeline.
    expect(quoteRow(d, quote.id).clientNote).toBe('Moins cher ?');
    expect(messages(d).map((row) => row.content)).toEqual([`Question / demande sur le devis #${quote.id}: Moins cher ?`, `Question sur le devis #${quote.id}: Et le joint ?`]);
    expect(events(d, 'QUOTE_MODIFICATION_REQUESTED').map((event) => event.metadata.question ?? false)).toEqual([false, true]);

    await asVisitor.ask(d, quote.id, { note: 'Et la pose ?' });

    expect(quoteRow(d, quote.id).clientNote).toBe('Moins cher ?');
    expect(messages(d).length).toBe(3);
  });

  it('the acceptance replaces the earlier question as the note of the quote, and is told once, with the revision', async () => {
    const d = desk();
    const quote = await sent(d);

    await ask(d, quote.id, { note: 'Une question' });
    await accept(d, quote.id);

    expect(quoteRow(d, quote.id).clientNote).toBe(null);
    expect(quoteRow(d, quote.id).acceptedAt).toBeDefined();
    expect(quoteRow(d, quote.id).acceptedAt).not.toBe(null);
    expect(events(d, 'QUOTE_ACCEPTED').map((event) => event.metadata.revision)).toEqual([1]);
    expect(told(d, 'notifications.notifyQuoteAccepted')).toBe(1);
  });

  it('a question about a quote that is not waiting for an answer is refused, and writes nothing', async () => {
    for (const how of ['accept', 'reject', 'cancel', 'expire', 'draft'] as const) {
      const d = desk();
      const quote = how === 'draft' ? await draft(d) : await sent(d);

      if (how === 'accept') await accept(d, quote.id);
      if (how === 'reject') await reject(d, quote.id);
      if (how === 'cancel') await d.world.svc.quotes.cancelQuote(quote.id, d.artisan.id);
      if (how === 'expire') await d.world.svc.quotes.expireQuote(quote.id, d.admin.id);

      const status = quoteRow(d, quote.id).status;
      const answer = await refusal(() => ask(d, quote.id, { note: 'Trop tard ?' }));

      // A draft is not the customer's: it does not exist for them (404). The others are refused (400).
      expect(answer?.status).toBe(how === 'draft' ? 404 : 400);
      expect(quoteRow(d, quote.id).status).toBe(status);
      expect(messages(d)).toEqual([]);
      expect(events(d, 'QUOTE_MODIFICATION_REQUESTED')).toEqual([]);
    }
  });

  it('only the customer of the job asks, accepts, refuses or asks for a change (403 for another customer)', async () => {
    const d = desk();
    const quote = await sent(d);

    for (const act of ['accept', 'reject', 'requestModification', 'askQuestion']) {
      const answer = await refusal(() => d.world.svc.quotes[act](d.stranger.id, quote.id, { note: 'Pirate' }));

      expect(answer?.status).toBe(403);
    }

    expect(quoteRow(d, quote.id).status).toBe('SENT');
    expect(messages(d)).toEqual([]);
  });

  it('a draft is not the customer\'s yet: nothing can be answered', async () => {
    const d = desk();
    const quote = await draft(d);

    for (const act of [accept, reject, change, ask, asVisitor.accept, asVisitor.reject, asVisitor.change, asVisitor.ask]) {
      const answer = await refusal(() => act(d, quote.id, { note: 'Déjà ?' }));

      expect([answer?.status, answer?.message]).toEqual([404, 'Devis introuvable.']);
    }

    expect(quoteRow(d, quote.id).status).toBe('DRAFT');
    expect(messages(d)).toEqual([]);
    expect(events(d, 'QUOTE_MODIFICATION_REQUESTED')).toEqual([]);
  });
});

describe('the revision the customer read (P2-04)', () => {
  beforeEach(() => resetLocale());

  it('an answer for the revision that was read goes through', async () => {
    const d = desk();
    const quote = await sent(d);

    await edit(d, quote.id, { title: 'Deuxième' });
    await accept(d, quote.id, { revision: 2 });

    expect(quoteRow(d, quote.id).status).toBe('ACCEPTED');
  });

  it('an acceptance for a revision that was edited since is refused (409) and nothing changes', async () => {
    const d = desk();
    const quote = await sent(d);

    await edit(d, quote.id, { items: [{ label: 'Main d’œuvre', quantity: 2, unitPrice: 90 }] });

    const answer = await refusal(() => accept(d, quote.id, { revision: 1, note: 'ok' }));

    expect(answer?.status).toBe(409);
    expect(answer?.message).toBe('Ce devis a été modifié depuis que vous l’avez consulté: relisez-le avant de répondre.');
    expect(quoteRow(d, quote.id).status).toBe('SENT');
    expect(quoteRow(d, quote.id).acceptedAt ?? null).toBe(null);
    expect(jobRow(d).status).toBe('QUOTE_SENT');
    expect(events(d, 'QUOTE_ACCEPTED')).toEqual([]);
    expect(told(d, 'notifications.notifyQuoteAccepted')).toBe(0);
  });

  it('a refusal and a request for a change are held to the revision too', async () => {
    const d = desk();
    const quote = await sent(d);

    await edit(d, quote.id, { title: 'Deuxième' });

    expect((await refusal(() => reject(d, quote.id, { revision: 1 })))?.status).toBe(409);
    expect((await refusal(() => change(d, quote.id, { revision: 1, note: 'x' })))?.status).toBe(409);
    expect(quoteRow(d, quote.id).status).toBe('SENT');
    expect(messages(d)).toEqual([]);
  });

  it('a question is not held to a revision: it may be about the old one', async () => {
    const d = desk();
    const quote = await sent(d);

    await edit(d, quote.id, { title: 'Deuxième' });
    await ask(d, quote.id, { note: 'Et avant ?', revision: 1 });

    expect(messages(d).length).toBe(1);
  });

  it('an answer that does not say which revision it read (nothing, or null) is for the quote as it is', async () => {
    const d = desk();
    const first = await sent(d);
    const second = await sent(d);

    await edit(d, first.id, { title: 'Deuxième' });
    await edit(d, second.id, { title: 'Deuxième' });
    await change(d, first.id, { revision: null });
    await accept(d, second.id, { revision: null });

    expect(quoteRow(d, first.id).status).toBe('CANCELLED');
    expect(quoteRow(d, second.id).status).toBe('ACCEPTED');
  });

  it('an answer that does not say which revision it read can accept a quote that was edited', async () => {
    const d = desk();
    const quote = await sent(d);

    await edit(d, quote.id, { title: 'Deuxième' });
    await accept(d, quote.id);

    expect(quoteRow(d, quote.id).status).toBe('ACCEPTED');
  });

  it('a revision from the future is refused as well', async () => {
    const d = desk();
    const quote = await sent(d);

    expect((await refusal(() => accept(d, quote.id, { revision: 5 })))?.status).toBe(409);
  });

  it('the customer reads the revision in the quote, and what to send back is that number', async () => {
    const d = desk();
    const quote = await sent(d);

    await edit(d, quote.id, { title: 'Deuxième' });

    const read: any[] = await d.world.svc.quotes.findForClient(d.client.id, d.job.id);

    expect(read[0].revision).toBe(2);
    expect((await accept(d, read[0].id, { revision: read[0].revision })).status).toBe('ACCEPTED');
  });
});

describe('accepting a quote (P2-04)', () => {
  beforeEach(() => resetLocale());

  it('the other quotes of the job that were still open are cancelled, the ones already decided are left alone', async () => {
    const d = desk();
    const first = await sent(d, { title: 'Premier' });
    const second = await sent(d, { title: 'Deuxième' });
    const third = await draft(d, { title: 'Troisième' });
    const refused = await sent(d, { title: 'Refusé' });
    const waiting = await sent(d, { title: 'À modifier' });

    await reject(d, refused.id);
    await change(d, waiting.id, { note: 'Autre prix' });
    await accept(d, second.id);

    const status = (id: number) => quoteRow(d, id).status;

    expect([first.id, second.id, third.id, refused.id, waiting.id].map(status)).toEqual(['CANCELLED', 'ACCEPTED', 'CANCELLED', 'REJECTED', 'CANCELLED']);
    expect(quoteRow(d, first.id).cancelledAt).not.toBe(null);
    expect(quoteRow(d, refused.id).cancelledAt ?? null).toBe(null);
  });

  it('the quote that is accepted is not marked as cancelled, and the quotes of another job are not touched', async () => {
    const d = desk();
    const quote = await sent(d);
    const otherJob = d.world.memory.plant('intervention', { clientId: d.client.id, artisanId: d.artisan.id, status: 'CREATED', serviceType: 'PLOMBIER' });
    const elsewhere = await d.world.svc.quotes.createForIntervention(otherJob.id, d.artisan.id, quoteDto());
    const elsewhereDraft = await d.world.svc.quotes.createDraftForIntervention(otherJob.id, d.artisan.id, quoteDto());

    await accept(d, quote.id);

    expect(quoteRow(d, quote.id).status).toBe('ACCEPTED');
    expect(quoteRow(d, quote.id).cancelledAt ?? null).toBe(null);
    expect(quoteRow(d, elsewhere.id).status).toBe('SENT');
    expect(quoteRow(d, elsewhereDraft.id).status).toBe('DRAFT');
    expect(rowsOf(d.world, 'intervention').find((row) => row.id === otherJob.id)!.status).toBe('QUOTE_SENT');
  });

  it('the job moves on when it waits for the quote, and is left where it is when it is already further', async () => {
    const waiting = desk();
    const quote = await sent(waiting);

    await accept(waiting, quote.id);

    expect(jobRow(waiting).status).toBe('QUOTE_ACCEPTED');
    expect(jobRow(waiting).quoteAcceptedAt).not.toBe(null);

    const further = desk({ status: 'ARTISAN_ACCEPTED' });
    const other = await sent(further);

    expect(jobRow(further).status).toBe('ARTISAN_ACCEPTED');

    await accept(further, other.id);

    expect(quoteRow(further, other.id).status).toBe('ACCEPTED');
    expect(jobRow(further).status).toBe('ARTISAN_ACCEPTED');
  });

  it('an acceptance twice, one after the other, is one acceptance: the second is turned away and tells nobody', async () => {
    const d = desk();
    const quote = await sent(d);

    await accept(d, quote.id);

    const answer = await refusal(() => accept(d, quote.id));

    expect(answer?.status).toBe(400);
    expect(answer?.message).toBe('Ce devis ne peut plus être accepté.');
    expect(events(d, 'QUOTE_ACCEPTED').length).toBe(1);
    expect(told(d, 'notifications.notifyQuoteAccepted')).toBe(1);
  });

  it('two acceptances at the same moment are one acceptance, one event and one notice', async () => {
    const d = desk();
    const quote = await sent(d);
    const answers = await Promise.all([refusal(() => accept(d, quote.id)), refusal(() => accept(d, quote.id))]);

    expect(answers.filter((answer) => answer === null).length).toBe(1);
    expect(answers.filter((answer) => answer?.status === 400).length).toBe(1);
    expect(events(d, 'QUOTE_ACCEPTED').length).toBe(1);
    expect(told(d, 'notifications.notifyQuoteAccepted')).toBe(1);
  });

  it('a refusal after an acceptance does not undo it, and an acceptance after a refusal is turned away', async () => {
    const d = desk();
    const first = await sent(d);
    const second = await sent(d);

    await reject(d, second.id);
    expect((await refusal(() => accept(d, second.id)))?.status).toBe(400);

    await accept(d, first.id);

    for (const act of [reject, change, ask]) expect((await refusal(() => act(d, first.id, { note: 'Finalement' })))?.status).toBe(400);

    expect(quoteRow(d, first.id).status).toBe('ACCEPTED');
    expect(quoteRow(d, second.id).status).toBe('REJECTED');
  });

  it('a quote that has expired cannot be accepted, but can still be refused or asked about', async () => {
    const d = desk();
    const quote = await sent(d);

    quoteRow(d, quote.id).expiresAt = new Date('2020-01-01T00:00:00.000Z');

    const answer = await refusal(() => accept(d, quote.id));

    expect(answer?.status).toBe(400);
    expect(answer?.message).toBe('Ce devis a expiré.');
    expect(quoteRow(d, quote.id).status).toBe('SENT');

    await ask(d, quote.id, { note: 'Encore valable ?' });
    await reject(d, quote.id);

    expect(quoteRow(d, quote.id).status).toBe('REJECTED');
  });
});

describe('the same answers by the tracking link (P2-04)', () => {
  beforeEach(() => resetLocale());

  it('the visitor asks, then accepts: the quote is accepted, the others cancelled, the job moves, the people are told', async () => {
    const d = desk();
    const quote = await sent(d);
    const other = await sent(d, { title: 'Autre devis' });
    const asked: any = await asVisitor.ask(d, quote.id, { note: 'Quand ?' });

    expect(asked.status).toBe('SENT');
    expect(quoteRow(d, quote.id).status).toBe('SENT');
    expect(messages(d).map((row) => [row.audience, row.senderId, row.content])).toEqual([['CLIENT_SUPPORT', d.client.id, `Question sur le devis #${quote.id}: Quand ?`]]);
    expect(events(d, 'QUOTE_MODIFICATION_REQUESTED').map((event) => [event.title, event.metadata.question, event.metadata.quoteId])).toEqual([['Question sur le devis', true, quote.id]]);

    const answer: any = await asVisitor.accept(d, quote.id, { note: 'Merci' });

    expect(answer.status).toBe('ACCEPTED');
    expect(quoteRow(d, quote.id).status).toBe('ACCEPTED');
    expect(quoteRow(d, quote.id).acceptedAt).not.toBe(null);
    expect(quoteRow(d, quote.id).clientNote).toBe('Merci');
    expect(quoteRow(d, other.id).status).toBe('CANCELLED');
    expect(jobRow(d).status).toBe('QUOTE_ACCEPTED');
    expect(events(d, 'QUOTE_ACCEPTED').length).toBe(1);
    expect(told(d, 'notifications.notifyQuoteAccepted')).toBe(1);
  });

  it('a quote that was accepted cannot be refused, changed or asked about by the link, and stays accepted', async () => {
    const d = desk();
    const quote = await sent(d);

    await asVisitor.accept(d, quote.id);

    for (const act of [asVisitor.reject, asVisitor.change, asVisitor.ask, asVisitor.accept]) {
      expect((await refusal(() => act(d, quote.id, { note: 'Finalement' })))?.status).toBe(400);
    }

    expect(quoteRow(d, quote.id).status).toBe('ACCEPTED');
    expect(events(d, 'QUOTE_REJECTED')).toEqual([]);
    expect(events(d, 'QUOTE_ACCEPTED').length).toBe(1);
  });

  it('a quote that was refused, cancelled, expired or is a draft cannot be answered by the link', async () => {
    for (const how of ['reject', 'cancel', 'expire', 'draft'] as const) {
      const d = desk();
      const quote = how === 'draft' ? await draft(d) : await sent(d);

      if (how === 'reject') await asVisitor.reject(d, quote.id);
      if (how === 'cancel') await d.world.svc.quotes.cancelQuote(quote.id, d.artisan.id);
      if (how === 'expire') await d.world.svc.quotes.expireQuote(quote.id, d.admin.id);

      const status = quoteRow(d, quote.id).status;

      for (const act of [asVisitor.accept, asVisitor.reject, asVisitor.change, asVisitor.ask]) {
        expect((await refusal(() => act(d, quote.id, { note: 'Encore' })))?.status).toBe(how === 'draft' ? 404 : 400);
      }

      expect(quoteRow(d, quote.id).status).toBe(status);
    }
  });

  it('a request for a change by the link moves the quote to "to modify": the visitor cannot accept it until it is sent again', async () => {
    const d = desk();
    const quote = await sent(d);

    await asVisitor.change(d, quote.id, { note: 'Moins cher ?' });

    expect(quoteRow(d, quote.id).status).toBe('MODIFICATION_REQUESTED');
    expect((await refusal(() => asVisitor.accept(d, quote.id)))?.status).toBe(400);
    expect(quoteRow(d, quote.id).status).toBe('MODIFICATION_REQUESTED');

    await edit(d, quote.id, { title: 'Moins cher' });
    await d.world.svc.quotes.sendQuote(quote.id, d.artisan.id);
    await asVisitor.accept(d, quote.id);

    expect(quoteRow(d, quote.id).status).toBe('ACCEPTED');
  });

  it('a quote that has expired cannot be accepted by the link', async () => {
    const d = desk();
    const quote = await sent(d);

    quoteRow(d, quote.id).expiresAt = new Date('2020-01-01T00:00:00.000Z');

    expect((await refusal(() => asVisitor.accept(d, quote.id)))?.message).toBe('Ce devis a expiré.');
    expect(quoteRow(d, quote.id).status).toBe('SENT');
  });

  it('the revision the visitor read is checked like the customer\'s', async () => {
    const d = desk();
    const quote = await sent(d);

    await edit(d, quote.id, { title: 'Deuxième' });

    expect((await refusal(() => asVisitor.accept(d, quote.id, { revision: 1 })))?.status).toBe(409);
    expect((await refusal(() => asVisitor.reject(d, quote.id, { revision: 1 })))?.status).toBe(409);
    expect((await refusal(() => asVisitor.change(d, quote.id, { revision: 1 })))?.status).toBe(409);
    expect(quoteRow(d, quote.id).status).toBe('SENT');

    await asVisitor.accept(d, quote.id, { revision: 2 });

    expect(quoteRow(d, quote.id).status).toBe('ACCEPTED');
  });

  it('the wrong link, and the quote of another job, are told the same: not found', async () => {
    const d = desk();
    const quote = await sent(d);
    const otherJob = d.world.memory.plant('intervention', { clientId: d.stranger.id, artisanId: d.other.id, status: 'CREATED', serviceType: 'PLOMBIER', trackingToken: crypto.createHash('sha256').update('autre-lien').digest('hex') });
    const elsewhere = await d.world.svc.quotes.createForIntervention(otherJob.id, d.other.id, quoteDto());

    for (const act of ['acceptQuote', 'rejectQuote', 'requestQuoteModification', 'askQuoteQuestion']) {
      expect((await refusal(() => d.world.svc.guest[act](d.job.id, elsewhere.id, d.token, { note: 'x' })))?.status).toBe(404);
      expect((await refusal(() => d.world.svc.guest[act](d.job.id, quote.id, 'mauvais-lien', { note: 'x' })))?.status).toBe(404);
      expect((await refusal(() => d.world.svc.guest[act](d.job.id, 99999, d.token, { note: 'x' })))?.status).toBe(404);
    }

    expect(quoteRow(d, quote.id).status).toBe('SENT');
    expect(quoteRow(d, elsewhere.id).status).toBe('SENT');
    expect(messages(d)).toEqual([]);
  });
});

describe('the edit, the cancellation, the sending and the answers are made one after the other on the same job (P2-04)', () => {
  beforeEach(() => resetLocale());

  it('an acceptance that waits for the job finds the quote cancelled meanwhile, and is turned away', async () => {
    const d = desk();
    const quote = await sent(d);
    const { answer, seen } = await whileHolding(
      d.world,
      (tx) => lockJob(tx, d.job.id),
      () => accept(d, quote.id),
      () => quoteRow(d, quote.id).status,
      async (tx) => {
        await tx.quote.update({ where: { id: quote.id }, data: { status: 'CANCELLED' } });
      },
    );

    expect(seen).toBe('SENT');
    expect(answer?.status).toBe(400);
    expect(quoteRow(d, quote.id).status).toBe('CANCELLED');
    expect(jobRow(d).status).toBe('QUOTE_SENT');
    expect(events(d, 'QUOTE_ACCEPTED')).toEqual([]);
    expect(told(d, 'notifications.notifyQuoteAccepted')).toBe(0);
  });

  it('an acceptance that waits for the job, for a revision that is edited meanwhile, is turned away (409)', async () => {
    const d = desk();
    const quote = await sent(d);
    const { answer, seen } = await whileHolding(
      d.world,
      (tx) => lockJob(tx, d.job.id),
      () => accept(d, quote.id, { revision: 1 }),
      () => quoteRow(d, quote.id).status,
      async (tx) => {
        await tx.quote.update({ where: { id: quote.id }, data: { revision: 2, title: 'Modifié pendant ce temps' } });
      },
    );

    expect(seen).toBe('SENT');
    expect(answer?.status).toBe(409);
    expect(quoteRow(d, quote.id).status).toBe('SENT');
  });

  it('a cancellation that waits for the job finds the quote accepted meanwhile, and is turned away', async () => {
    const d = desk();
    const quote = await sent(d);
    const { answer, seen } = await whileHolding(
      d.world,
      (tx) => lockJob(tx, d.job.id),
      () => d.world.svc.quotes.cancelQuote(quote.id, d.artisan.id),
      () => quoteRow(d, quote.id).status,
      async (tx) => {
        await tx.quote.update({ where: { id: quote.id }, data: { status: 'ACCEPTED' } });
      },
    );

    expect(seen).toBe('SENT');
    expect(answer?.status).toBe(400);
    expect(quoteRow(d, quote.id).status).toBe('ACCEPTED');
    expect(events(d, 'CANCELLED')).toEqual([]);
  });

  it('an edit that waits for the job finds the quote accepted meanwhile, and is turned away without a version', async () => {
    const d = desk();
    const quote = await sent(d);
    const { answer } = await whileHolding(
      d.world,
      (tx) => lockJob(tx, d.job.id),
      () => edit(d, quote.id, { title: 'Trop tard' }),
      () => quoteRow(d, quote.id).title,
      async (tx) => {
        await tx.quote.update({ where: { id: quote.id }, data: { status: 'ACCEPTED' } });
      },
    );

    expect(answer?.status).toBe(400);
    expect(quoteRow(d, quote.id).title).toBe('Réparation fuite');
    expect(versionsOf(d, quote.id)).toEqual([]);
  });

  it('an edit that waits for the job works from the quote as it is by then (the version it keeps is the one of that moment)', async () => {
    const d = desk();
    const quote = await sent(d);
    const { answer } = await whileHolding(
      d.world,
      (tx) => lockJob(tx, d.job.id),
      () => edit(d, quote.id, { taxRate: 7 }),
      () => num(quoteRow(d, quote.id).revision),
      async (tx) => {
        await tx.quote.update({ where: { id: quote.id }, data: { title: 'Titre posé entre-temps' } });
      },
    );

    expect(answer).toBe(null);
    expect(versionsOf(d, quote.id).map((row) => [row.revision, row.title])).toEqual([[1, 'Titre posé entre-temps']]);
    expect(quoteRow(d, quote.id).title).toBe('Titre posé entre-temps');
    expectConsistent(d, quote.id);
  });

  it('a sending that waits for the job finds the quote already sent and answered, and is turned away', async () => {
    const d = desk();
    const quote = await draft(d);
    const { answer } = await whileHolding(
      d.world,
      (tx) => lockJob(tx, d.job.id),
      () => d.world.svc.quotes.sendQuote(quote.id, d.artisan.id),
      () => quoteRow(d, quote.id).status,
      async (tx) => {
        await tx.quote.update({ where: { id: quote.id }, data: { status: 'REJECTED' } });
      },
    );

    expect(answer?.status).toBe(400);
    expect(quoteRow(d, quote.id).status).toBe('REJECTED');
    expect(events(d, 'QUOTE_SENT')).toEqual([]);
    expect(told(d, 'notifications.notifyQuoteSent')).toBe(0);
  });

  it('an expiry that waits for the job finds the quote accepted meanwhile, and is turned away', async () => {
    const d = desk();
    const quote = await sent(d);
    const { answer } = await whileHolding(
      d.world,
      (tx) => lockJob(tx, d.job.id),
      () => d.world.svc.quotes.expireQuote(quote.id, d.admin.id),
      () => quoteRow(d, quote.id).status,
      async (tx) => {
        await tx.quote.update({ where: { id: quote.id }, data: { status: 'ACCEPTED' } });
      },
    );

    expect(answer?.status).toBe(400);
    expect(quoteRow(d, quote.id).status).toBe('ACCEPTED');
  });

  it('a question that waits for the job finds the quote accepted meanwhile, and is turned away without a message', async () => {
    const d = desk();
    const quote = await sent(d);
    const { answer } = await whileHolding(
      d.world,
      (tx) => lockJob(tx, d.job.id),
      () => ask(d, quote.id, { note: 'Une question ?' }),
      () => messages(d).length,
      async (tx) => {
        await tx.quote.update({ where: { id: quote.id }, data: { status: 'ACCEPTED' } });
      },
    );

    expect(answer?.status).toBe(400);
    expect(messages(d)).toEqual([]);
    expect(quoteRow(d, quote.id).clientNote ?? null).toBe(null);
  });

  it('an acceptance by the link waits for the job in the same way', async () => {
    const d = desk();
    const quote = await sent(d);
    const { answer } = await whileHolding(
      d.world,
      (tx) => lockJob(tx, d.job.id),
      () => asVisitor.accept(d, quote.id),
      () => quoteRow(d, quote.id).status,
      async (tx) => {
        await tx.quote.update({ where: { id: quote.id }, data: { status: 'CANCELLED' } });
      },
    );

    expect(answer?.status).toBe(400);
    expect(quoteRow(d, quote.id).status).toBe('CANCELLED');
    expect(jobRow(d).status).toBe('QUOTE_SENT');
  });

  it('an acceptance and a cancellation at the same moment: one of them wins, never both', async () => {
    const d = desk();
    const quote = await sent(d);
    const answers = await Promise.all([refusal(() => accept(d, quote.id)), refusal(() => d.world.svc.quotes.cancelQuote(quote.id, d.artisan.id))]);
    const status = quoteRow(d, quote.id).status;

    expect(['ACCEPTED', 'CANCELLED']).toContain(status);
    expect(answers.filter((answer) => answer === null).length).toBe(1);
    expect(events(d, 'QUOTE_ACCEPTED').length).toBe(status === 'ACCEPTED' ? 1 : 0);
    expect(events(d, 'CANCELLED').length).toBe(status === 'CANCELLED' ? 1 : 0);
  });

  it('an acceptance and an edit at the same moment: either the customer accepts what was edited, or the edit is turned away', async () => {
    const d = desk();
    const quote = await sent(d);
    const answers = await Promise.all([refusal(() => accept(d, quote.id, { revision: 1 })), refusal(() => edit(d, quote.id, { title: 'En même temps' }))]);
    const row = quoteRow(d, quote.id);

    if (row.status === 'ACCEPTED') {
      // The customer accepted revision 1: the edit either came after (turned away) or came first and the acceptance was refused.
      expect(row.title).toBe('Réparation fuite');
      expect(answers[1]?.status).toBe(400);
    } else {
      expect(row.title).toBe('En même temps');
      expect(answers[0]?.status).toBe(409);
    }
  });
});

describe('a job that is closed answers no quote (P2-04)', () => {
  beforeEach(() => resetLocale());

  const WORDS = 'Cette mission n’accepte plus de réponse sur ses devis.';

  it('on a cancelled, disputed, done or waiting-to-be-paid job nothing is answered, by the customer or by the link, and nothing is written', async () => {
    // INVOICE_READY is the old spelling of INVOICE_SENT.
    for (const status of ['CANCELLED', 'DISPUTED', 'COMPLETED', 'PAYMENT_PENDING', 'PAID', 'INVOICE_SENT', 'INVOICE_READY']) {
      for (const who of [{ accept, reject, change, ask }, asVisitor]) {
        const d = desk();
        const quote = await sent(d);

        await d.world.prisma.intervention.update({ where: { id: d.job.id }, data: { status } });

        for (const act of [who.accept, who.reject, who.change, who.ask]) {
          const answer = await refusal(() => act(d, quote.id, { note: 'Trop tard' }));

          expect([status, answer?.status, answer?.message]).toEqual([status, 400, WORDS]);
        }

        expect([status, quoteRow(d, quote.id).status, quoteRow(d, quote.id).clientNote ?? null]).toEqual([status, 'SENT', null]);
        expect(jobRow(d).status).toBe(status);
        expect(messages(d)).toEqual([]);
        expect(events(d).filter((event) => /QUOTE_(ACCEPTED|REJECTED|MODIFICATION_REQUESTED)/.test(String(event.type)))).toEqual([]);
        expect(told(d, 'notifications.notifyQuoteAccepted')).toBe(0);
      }
    }
  });

  it('a job that is still going on answers: waiting for review, quote sent, assigned, on its way, in progress', async () => {
    for (const status of ['WAITING_ADMIN_REVIEW', 'QUOTE_SENT', 'ASSIGNED', 'ARTISAN_ACCEPTED', 'IN_PROGRESS']) {
      const d = desk();
      const quote = await sent(d);

      await d.world.prisma.intervention.update({ where: { id: d.job.id }, data: { status } });
      await ask(d, quote.id, { note: 'Une question' });
      await asVisitor.accept(d, quote.id);

      expect([status, quoteRow(d, quote.id).status]).toEqual([status, 'ACCEPTED']);
      expect(messages(d).length).toBe(1);
    }
  });

  it('a job that is cancelled when the answer gets the lock is found cancelled: the answer is turned away', async () => {
    const d = desk();
    const quote = await sent(d);
    const { answer, seen } = await whileHolding(
      d.world,
      (tx) => lockJob(tx, d.job.id),
      () => accept(d, quote.id),
      () => quoteRow(d, quote.id).status,
      async (tx) => {
        await tx.intervention.update({ where: { id: d.job.id }, data: { status: 'CANCELLED' } });
      },
    );

    expect(seen).toBe('SENT');
    expect([answer?.status, answer?.message]).toEqual([400, WORDS]);
    expect(quoteRow(d, quote.id).status).toBe('SENT');
    expect(jobRow(d).status).toBe('CANCELLED');
  });
});

describe('what an edit of an older quote puts right (P2-04)', () => {
  beforeEach(() => resetLocale());

  it('a quote whose amounts had drifted (all three, or any one): an edit of the PDF alone, or of the date alone, puts them right, keeps what the customer read, and raises the revision', async () => {
    const right = { amountHT: 93.5, taxAmount: 17.765, amountTTC: 111.265 };

    for (const drift of [{ amountHT: 50, taxAmount: 1, amountTTC: 51 }, { amountHT: 50 }, { taxAmount: 1 }, { amountTTC: 51 }]) {
      for (const change of [{ pdfUrl: 'https://files.example.test/devis.pdf' }, { expiresAt: '2027-01-01T00:00:00.000Z' }]) {
        const d = desk();
        const quote = await sent(d);

        await d.world.prisma.quote.update({ where: { id: quote.id }, data: drift });
        await edit(d, quote.id, change);

        expect(amountsOf(quoteRow(d, quote.id))).toEqual(right);
        expect(num(quoteRow(d, quote.id).revision)).toBe(2);
        expect(versionsOf(d, quote.id).map((row) => [num(row.revision), amountsOf(row)])).toEqual([[1, { ...right, ...drift }]]);
        // The customer who read the old price is told (409), and the one who reads it again accepts the new one.
        expect((await refusal(() => accept(d, quote.id, { revision: 1 })))?.status).toBe(409);

        await accept(d, quote.id, { revision: 2 });

        expect(quoteRow(d, quote.id).status).toBe('ACCEPTED');
      }
    }
  });

  it('an edit that sends no lines writes again the lines whose totals were not the quantity times the price', async () => {
    const d = desk();
    const quote = await sent(d, { items: [{ label: 'Pièce', quantity: 1, unitPrice: 12.345 }] });

    await d.world.prisma.quoteItem.updateMany({ where: { quoteId: quote.id }, data: { total: 12.35 } });

    expect(num(itemsOf(d, quote.id)[0].total)).toBe(12.35);

    await edit(d, quote.id, { description: 'Avec la pièce' });

    expect(itemsOf(d, quote.id).length).toBe(1);
    expect(num(itemsOf(d, quote.id)[0].total)).toBe(12.345);
    expectConsistent(d, quote.id);
    // The total of the line the customer read was another: it is a change of what they read.
    expect(num(quoteRow(d, quote.id).revision)).toBe(2);
    expect(num(versionsOf(d, quote.id)[0].revision)).toBe(1);
  });

  it('an edit that changes nothing the customer reads does not rewrite the lines', async () => {
    const d = desk();
    const quote = await sent(d);
    const before = JSON.stringify(itemsOf(d, quote.id));

    await edit(d, quote.id, { expiresAt: '2027-01-01T00:00:00.000Z' });

    expect(JSON.stringify(itemsOf(d, quote.id))).toBe(before);
    expect(num(quoteRow(d, quote.id).revision)).toBe(1);
    expect(versionsOf(d, quote.id)).toEqual([]);
  });
});

describe('the right to write is checked again once the job is locked (P2-04)', () => {
  beforeEach(() => resetLocale());

  const handOver = (d: Desk) => async (tx: any) => {
    await tx.intervention.update({ where: { id: d.job.id }, data: { artisanId: d.other.id } });
  };

  it('an edit that waits for the job, which is given to another artisan meanwhile, is refused (403) and writes nothing', async () => {
    const d = desk();
    const quote = await sent(d);
    const before = JSON.stringify(quoteRow(d, quote.id));
    const { answer } = await whileHolding(d.world, (tx) => lockJob(tx, d.job.id), () => edit(d, quote.id, { title: 'Trop tard' }), () => 0, handOver(d));

    expect(answer?.status).toBe(403);
    expect(JSON.stringify(quoteRow(d, quote.id))).toBe(before);
    expect(versionsOf(d, quote.id)).toEqual([]);
  });

  it('a sending that waits for the job, which is given to another artisan meanwhile, is refused (403) and the draft stays a draft', async () => {
    const d = desk();
    const quote = await draft(d);
    const { answer } = await whileHolding(d.world, (tx) => lockJob(tx, d.job.id), () => d.world.svc.quotes.sendQuote(quote.id, d.artisan.id), () => 0, handOver(d));

    expect(answer?.status).toBe(403);
    expect(quoteRow(d, quote.id).status).toBe('DRAFT');
    expect(events(d, 'QUOTE_SENT')).toEqual([]);
  });

  it('a cancellation that waits for the job, which is given to another artisan meanwhile, is refused (403) and the quote stays sent', async () => {
    const d = desk();
    const quote = await sent(d);
    const { answer } = await whileHolding(d.world, (tx) => lockJob(tx, d.job.id), () => d.world.svc.quotes.cancelQuote(quote.id, d.artisan.id), () => 0, handOver(d));

    expect(answer?.status).toBe(403);
    expect(quoteRow(d, quote.id).status).toBe('SENT');
  });
});

describe('the PDF of a quote (P2-04)', () => {
  beforeEach(() => resetLocale());

  const URL = 'https://files.example.test/devis.pdf';

  it('the assigned artisan, the staff and the system attach it to a quote that can still be edited', async () => {
    for (const by of ['artisan', 'admin', 'dispatcher', undefined] as const) {
      const d = desk();
      const quote = await sent(d);
      const updated: any = await d.world.svc.quotes.setPdfUrl(quote.id, URL, by === undefined ? undefined : d[by].id);

      expect(updated.pdfUrl).toBe(URL);
      expect(quoteRow(d, quote.id).pdfUrl).toBe(URL);
    }
  });

  it('a quote that is accepted, refused, cancelled or expired keeps the PDF it was answered with (400)', async () => {
    for (const how of ['accept', 'reject', 'cancel', 'expire'] as const) {
      const d = desk();
      const quote = await sent(d, { pdfUrl: 'https://files.example.test/ancien.pdf' });

      if (how === 'accept') await accept(d, quote.id);
      if (how === 'reject') await reject(d, quote.id);
      if (how === 'cancel') await d.world.svc.quotes.cancelQuote(quote.id, d.artisan.id);
      if (how === 'expire') await d.world.svc.quotes.expireQuote(quote.id, d.admin.id);

      const before = JSON.stringify(quoteRow(d, quote.id));

      expect((await refusal(() => d.world.svc.quotes.setPdfUrl(quote.id, URL, d.artisan.id)))?.status).toBe(400);
      expect(JSON.stringify(quoteRow(d, quote.id))).toBe(before);
    }
  });

  it('another artisan, the customer and the accountant are refused (403)', async () => {
    const d = desk();
    const quote = await sent(d);
    const before = JSON.stringify(quoteRow(d, quote.id));

    for (const person of [d.other, d.client, d.accountant]) {
      expect((await refusal(() => d.world.svc.quotes.setPdfUrl(quote.id, URL, person.id)))?.status).toBe(403);
    }

    expect((await refusal(() => d.world.svc.quotes.setPdfUrl(99999, URL, d.admin.id)))?.status).toBe(404);
    expect(JSON.stringify(quoteRow(d, quote.id))).toBe(before);
  });

  it('a PDF that waits for the job, which finds the quote accepted meanwhile, is turned away and the PDF is not replaced', async () => {
    const d = desk();
    const quote = await sent(d, { pdfUrl: 'https://files.example.test/ancien.pdf' });
    const { answer } = await whileHolding(
      d.world,
      (tx) => lockJob(tx, d.job.id),
      () => d.world.svc.quotes.setPdfUrl(quote.id, URL, d.artisan.id),
      () => quoteRow(d, quote.id).pdfUrl,
      async (tx) => {
        await tx.quote.update({ where: { id: quote.id }, data: { status: 'ACCEPTED' } });
      },
    );

    expect(answer?.status).toBe(400);
    expect(quoteRow(d, quote.id).pdfUrl).toBe('https://files.example.test/ancien.pdf');
  });

  it('a PDF that waits for the job, which is given to another artisan meanwhile, is refused (403)', async () => {
    const d = desk();
    const quote = await sent(d);
    const { answer } = await whileHolding(
      d.world,
      (tx) => lockJob(tx, d.job.id),
      () => d.world.svc.quotes.setPdfUrl(quote.id, URL, d.artisan.id),
      () => 0,
      async (tx) => {
        await tx.intervention.update({ where: { id: d.job.id }, data: { artisanId: d.other.id } });
      },
    );

    expect(answer?.status).toBe(403);
    expect(quoteRow(d, quote.id).pdfUrl ?? null).toBe(null);
  });
});

describe('the row of the job is held while a quote is answered (P2-04)', () => {
  beforeEach(() => resetLocale());

  /** After the answer has read the status of the job, the job is cancelled by a writer that does not take the lock of the job. */
  function cancelAfterTheRead(d: Desk) {
    const memory: any = d.world.memory;
    const original = memory.delegate.bind(memory);
    let done = false;

    memory.delegate = (model: string, tx: any) => {
      const delegate = original(model, tx);

      if (model !== 'Intervention' || !tx) return delegate;

      return new Proxy(delegate, {
        get: (target, key) =>
          key === 'findUnique'
            ? async (args: any) => {
                const found = await target.findUnique(args);

                if (!done && args?.select?.status) {
                  done = true;
                  // written by another request, outside this transaction: it is not undone when this one is turned away
                  await original(model, undefined).update({ where: { id: d.job.id }, data: { status: 'CANCELLED' } });
                }

                return found;
              }
            : target[key],
      });
    };
  }

  it('a job cancelled between the moment the answer reads it and the moment it holds it: the answer is turned away (409), nothing is written, nobody is told', async () => {
    for (const how of ['accept', 'reject', 'change', 'ask'] as const) {
      for (const who of [{ accept, reject, change, ask }, asVisitor]) {
        const d = desk();
        const quote = await sent(d);

        cancelAfterTheRead(d);

        const answer = await refusal(() => who[how](d, quote.id, { note: 'Au même moment' }));

        expect([how, answer?.status, answer?.message]).toEqual([how, 409, 'La mission vient de changer: relisez le devis avant de répondre.']);
        expect(quoteRow(d, quote.id).status).toBe('SENT');
        expect(jobRow(d).status).toBe('CANCELLED');
        expect(messages(d)).toEqual([]);
        expect(events(d, 'QUOTE_ACCEPTED')).toEqual([]);
        expect(told(d, 'notifications.notifyQuoteAccepted')).toBe(0);
      }
    }
  });

  it('the hold changes nothing for a job that stays as it is, whatever its status', async () => {
    for (const status of ['QUOTE_SENT', 'ASSIGNED', 'IN_PROGRESS']) {
      const d = desk();
      const quote = await sent(d);

      await d.world.prisma.intervention.update({ where: { id: d.job.id }, data: { status } });
      await accept(d, quote.id);

      expect(quoteRow(d, quote.id).status).toBe('ACCEPTED');
    }
  });
});

describe('a quote is created under the lock of the job (P2-04)', () => {
  beforeEach(() => resetLocale());

  it('a quote, or a draft, that waits for the job, which is given to another artisan meanwhile, is refused (403) and nothing is created or told', async () => {
    for (const make of [(d: Desk) => sent(d), (d: Desk) => draft(d)]) {
      const d = desk();
      const { answer } = await whileHolding(
        d.world,
        (tx) => lockJob(tx, d.job.id),
        () => make(d),
        () => rowsOf(d.world, 'quote').length,
        async (tx) => {
          await tx.intervention.update({ where: { id: d.job.id }, data: { artisanId: d.other.id } });
        },
      );

      expect(answer?.status).toBe(403);
      expect(rowsOf(d.world, 'quote')).toEqual([]);
      expect(events(d, 'QUOTE_SENT')).toEqual([]);
      expect(told(d, 'notifications.notifyQuoteSent')).toBe(0);
    }
  });

  it('a quote created while nobody holds the lock is created and told as before', async () => {
    const d = desk();
    const quote = await sent(d);

    expect(quoteRow(d, quote.id).status).toBe('SENT');
    expect(events(d, 'QUOTE_SENT').length).toBe(1);
    expect(told(d, 'notifications.notifyQuoteSent')).toBe(1);
  });
});
