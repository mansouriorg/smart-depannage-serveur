import { auditNumbers } from './number-audit';
import { Decimal } from '../../common/testing/decimal-double';
import { World, emptyWorld } from '../../common/testing/world';
import { resetLocale } from '../../common/locale/locale';
import { sendPdf } from './pdf/pdf-files';
import * as fs from 'fs';
import * as path from 'path';
import { TICKET_STAFF_ROLES } from '../../common/auth/role-policy';
import { routeKey, scanController } from '../../common/testing/route-roles';
import { stripComments } from '../../common/testing/source-scan';
import { businessYearMonth } from '../../common/locale/business-time';

/**
 * The invoices of P2-07, on the real services and a database that keeps what a transaction wrote and forgets what a failed one
 * wrote: numbers in order without gaps, credit notes, the paid rule, the mentions the invoice keeps, the PDF, the settings.
 */
/** The year the numbers carry: the year of the business clock (Tunis), which is not the year of the machine in the hour around New Year. */
const YEAR = businessYearMonth(new Date()).year;
const num = (value: unknown) => Number(String(value));
const text = (value: unknown) => String(value);

interface DeskOptions {
  amount?: number;
  taxRate?: number;
  settings?: Record<string, unknown> | null;
  status?: string;
}

/** A job with an accepted quote, the company settings, and the people who touch an invoice. */
function desk(options: DeskOptions = {}) {
  resetLocale();

  const world = emptyWorld();
  const make = (role: string, name: string, extra: Record<string, unknown> = {}) => world.memory.plant('user', { role, name, ...extra });
  const admin = make('ADMIN', 'Admin');
  const accountant = make('ACCOUNTANT', 'Comptable');
  const client = make('CLIENT', 'Amine Ben Salah', { email: 'amine@example.tn', phone: '+21622123456', taxId: '7654321/B/A/000' });
  const stranger = make('CLIENT', 'Autre client');
  const artisan = make('ARTISAN', 'Artisan');

  world.memory.plant('artisanProfile', { userId: artisan.id, verificationStatus: 'APPROVED' });

  if (options.settings !== null) {
    world.memory.plant('companySettings', {
      companyName: 'Smart-Dépannage SARL',
      companyPhone: '+216 71 000 000',
      companyEmail: 'facturation@smart-depannage.tn',
      matriculeFiscal: '1234567/A/M/000',
      rib: '08006012345678901234',
      paymentMethods: ['ONLINE', 'CASH', 'BANK_TRANSFER'],
      companyAddress: '12 Avenue Habib Bourguiba, 1001 Tunis',
      registreCommerce: 'B01234562026',
      invoiceLegalMentions: 'Société à responsabilité limitée au capital de 10 000 TND.',
      paymentTerms: 'Paiement à réception de la facture.',
      stampDuty: 0,
      ...options.settings,
    });
  }

  const jobs: Array<Record<string, any>> = [];
  const newJob = () => {
    const job = world.memory.plant('intervention', {
      clientId: client.id,
      artisanId: artisan.id,
      status: options.status ?? 'COMPLETED',
      serviceType: 'PLOMBIER',
      address: '5 Rue de Marseille, La Marsa',
      description: 'Fuite sous l’évier',
      contactName: null,
    });
    const net = options.amount ?? 100;
    const rate = options.taxRate ?? 19;
    const tax = Math.round(net * rate * 10) / 1000;

    world.memory.plant('quote', { interventionId: job.id, createdById: artisan.id, status: 'ACCEPTED', amountHT: net, taxRate: rate, taxAmount: tax, amountTTC: net + tax, currency: 'TND' });
    jobs.push(job);

    return job;
  };

  const job = newJob();

  return { world, admin, accountant, client, stranger, artisan, job, newJob, jobs };
}

type Desk = ReturnType<typeof desk>;

const rows = (d: Desk, model: string) => d.world.memory.rows(model);
const invoicesOf = (d: Desk) => rows(d, 'invoice');
const creditNotesOf = (d: Desk) => rows(d, 'creditNote');
const asAdmin = (d: Desk) => ({ id: d.admin.id, role: 'ADMIN' as any });
const asAccountant = (d: Desk) => ({ id: d.accountant.id, role: 'ACCOUNTANT' as any });
const asClient = (d: Desk) => ({ id: d.client.id, role: 'CLIENT' as any });
const asStranger = (d: Desk) => ({ id: d.stranger.id, role: 'CLIENT' as any });
const asArtisan = (d: Desk) => ({ id: d.artisan.id, role: 'ARTISAN' as any });

const issue = (d: Desk, jobId = d.job.id, dto: Record<string, unknown> = {}): Promise<any> => d.world.svc.invoices.createForIntervention(jobId, d.admin.id, dto as any);

/** Records a payment of the job as the back office would and confirms it. */
async function pay(d: Desk, amount: number, jobId = d.job.id): Promise<number> {
  const asked = await d.world.svc.payments.createAdminManualPayment(d.admin.id, jobId, { method: 'BANK_TRANSFER', amount });

  await d.world.svc.payments.confirm(asked.id, d.admin.id, {});

  return asked.id;
}

async function refusal(work: () => Promise<unknown>): Promise<{ status: number; message: string } | null> {
  try {
    await work();
  } catch (error) {
    const known = error as { getStatus?: () => number; message?: string };

    return { status: typeof known.getStatus === 'function' ? known.getStatus() : 500, message: String(known.message) };
  }

  return null;
}

/** Whether the numbers of the database have no gaps, by the audit the back office runs. */
function audit(world: World) {
  const asDocument = (row: Record<string, any>, numberOf: string) => ({ id: row.id, number: row[numberOf], year: row.numberYear ?? null, sequence: row.sequence ?? null });

  return auditNumbers(
    {
      INVOICE: world.memory.rows('invoice').map((row) => asDocument(row, 'invoiceNumber')),
      CREDIT_NOTE: world.memory.rows('creditNote').map((row) => asDocument(row, 'creditNoteNumber')),
    },
    world.memory.rows('documentCounter').map((row) => ({ series: row.series, year: row.year, last: row.last })),
  );
}

/** Runs `work` while `new Date()` answers `iso`. */
async function atInstant<T = any>(iso: string, work: () => Promise<T>): Promise<T> {
  const RealDate = Date;
  const fixed = new RealDate(iso).getTime();

  class FixedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(fixed);
      else super(...(args as [number]));
    }

    static now() {
      return fixed;
    }
  }

  (globalThis as any).Date = FixedDate;

  try {
    return await work();
  } finally {
    (globalThis as any).Date = RealDate;
  }
}

describe('invoice numbers are in order and have no gaps (P2-07)', () => {
  it('numbers the invoices of the year 1, 2, 3 in the order they are issued, from a counter', async () => {
    const d = desk();
    const second = d.newJob();
    const third = d.newJob();

    const a = await issue(d);
    const b = await issue(d, second.id);
    const c = await issue(d, third.id);

    expect([a.invoiceNumber, b.invoiceNumber, c.invoiceNumber]).toEqual([`F-${YEAR}-0001`, `F-${YEAR}-0002`, `F-${YEAR}-0003`]);
    expect(invoicesOf(d).map((row) => [row.numberYear, row.sequence])).toEqual([[YEAR, 1], [YEAR, 2], [YEAR, 3]]);
    expect(rows(d, 'documentCounter').map((row) => [row.series, row.year, row.last])).toEqual([['INVOICE', YEAR, 3]]);
    expect(audit(d.world).ok).toBe(true);
  });

  it('gives the invoices that are issued at the same moment each a number of its own, with none missing', async () => {
    const d = desk();
    const jobs = [d.job, ...Array.from({ length: 11 }, () => d.newJob())];

    const made = await Promise.all(jobs.map((job) => issue(d, job.id)));
    const sequences = made.map((invoice) => invoicesOf(d).find((row) => row.id === invoice.id)!.sequence).sort((a, b) => a - b);

    expect(sequences).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(new Set(made.map((invoice) => invoice.invoiceNumber)).size).toBe(12);
    expect(audit(d.world).ok).toBe(true);
  });

  it('does not use up a number when the invoice fails to save: the next one takes it', async () => {
    const d = desk();
    const elsewhere = d.newJob();

    // The database refuses the invoice after the number was taken (a row already holds the number: the unique constraint of the series).
    d.world.memory.plant('invoice', { interventionId: elsewhere.id, invoiceNumber: 'STRAY-1', numberYear: YEAR, sequence: 1, status: 'CANCELLED' });

    const failed = await refusal(() => issue(d));

    // It is the series that refuses (the rank is already taken), not something else going wrong on the way.
    expect(failed?.message).toContain('Unique constraint failed on the fields: (`numberYear`,`sequence`)');
    expect(invoicesOf(d).map((row) => row.invoiceNumber)).toEqual(['STRAY-1']);
    expect(rows(d, 'documentCounter')).toEqual([]);

    d.world.clear('invoice');

    const ok = await issue(d);

    expect(ok.invoiceNumber).toBe(`F-${YEAR}-0001`);
    expect(rows(d, 'documentCounter').map((row) => row.last)).toEqual([1]);
    expect(audit(d.world).ok).toBe(true);
  });

  it('starts again at 1 in the new year, on the clock of Tunis (23:30 UTC on 31 December is already 1 January there)', async () => {
    const d = desk();
    const second = d.newJob();
    const third = d.newJob();

    const last = await atInstant('2026-12-31T22:30:00Z', () => issue(d));
    const first = await atInstant('2026-12-31T23:30:00Z', () => issue(d, second.id));
    const next = await atInstant('2027-03-01T10:00:00Z', () => issue(d, third.id));

    expect([last.invoiceNumber, first.invoiceNumber, next.invoiceNumber]).toEqual(['F-2026-0001', 'F-2027-0001', 'F-2027-0002']);
    expect(audit(d.world).ok).toBe(true);
  });

  it('keeps the number of an invoice that was cancelled in the series: the one that replaces it has the next number', async () => {
    const d = desk();
    const first = await issue(d);

    await d.world.svc.invoices.cancelInvoice(asAdmin(d), first.id, { reason: 'Erreur de saisie' });

    const second = await issue(d);

    expect([first.invoiceNumber, second.invoiceNumber]).toEqual([`F-${YEAR}-0001`, `F-${YEAR}-0002`]);
    expect(invoicesOf(d).map((row) => row.status)).toEqual(['CANCELLED', 'ISSUED']);
    expect(audit(d.world).ok).toBe(true);
  });

  it('refuses a second invoice while one is out, and takes no number for it', async () => {
    const d = desk();

    await issue(d);

    const second = await refusal(() => issue(d));
    // Whatever else is wrong with the request, what the back office is told is that an invoice is out.
    const typedWrong = await refusal(() => issue(d, d.job.id, { amountHT: 100, taxRate: 18 }));

    expect(second?.status).toBe(400);
    expect(second?.message).toContain('existe déjà');
    expect(typedWrong?.message).toContain('existe déjà');
    expect(invoicesOf(d)).toHaveLength(1);
    expect(rows(d, 'documentCounter').map((row) => row.last)).toEqual([1]);
  });

  it('two invoices asked for the same job at the same moment make one: the other finds it, and takes no number', async () => {
    const d = desk();
    const results = await Promise.all([refusal(() => issue(d)), refusal(() => issue(d))]);

    expect(results.filter((result) => result === null)).toHaveLength(1);
    expect(results.filter((result) => result?.status === 400)).toHaveLength(1);
    expect(invoicesOf(d)).toHaveLength(1);
    expect(rows(d, 'documentCounter').map((row) => row.last)).toEqual([1]);
    expect(audit(d.world).ok).toBe(true);
  });

  it('does not take a number for an invoice that is refused for its amount or its rate', async () => {
    const d = desk({ amount: 0 });
    const tooLow = await refusal(() => issue(d));
    const other = desk();
    const wrongRate = await refusal(() => issue(other, other.job.id, { amountHT: 100, taxRate: 18 }));

    expect(tooLow?.status).toBe(400);
    expect(wrongRate?.status).toBe(400);
    expect(wrongRate?.message).toContain('18');
    expect(rows(d, 'documentCounter')).toEqual([]);
    expect(rows(other, 'documentCounter')).toEqual([]);
  });

  it('takes a VAT rate that the company lists, to the millime', async () => {
    const d = desk();
    const invoice = await issue(d, d.job.id, { amountHT: 12.345, taxRate: 7 });
    const stored = invoicesOf(d)[0];

    expect([text(stored.amountHT), text(stored.taxAmount), text(stored.amountTTC), num(stored.taxRate)]).toEqual(['12.345', '0.864', '13.209', 7]);
    expect(invoice.id).toBe(stored.id);
  });

  it('is audited as having no gaps after any mix of invoices and credit notes', async () => {
    const d = desk();
    const jobs = [d.job, d.newJob(), d.newJob(), d.newJob()];
    const made = [] as Array<Record<string, any>>;

    for (const job of jobs) made.push(await issue(d, job.id));

    await d.world.svc.invoices.createCreditNote(asAdmin(d), made[0].id, { reason: 'Geste commercial', amountTTC: 10 });
    await d.world.svc.invoices.createCreditNote(asAdmin(d), made[1].id, { reason: 'Prestation annulée' });
    await d.world.svc.invoices.createCreditNote(asAdmin(d), made[0].id, { reason: 'Deuxième geste', amountTTC: 5 });

    const report = audit(d.world);

    expect(report.ok).toBe(true);
    expect(report.years.map((year) => `${year.series}:${year.count}:${year.counter}`)).toEqual([`INVOICE:4:4`, `CREDIT_NOTE:3:3`]);
  });
});

describe('what the invoice says is kept as it was the day it was issued (P2-07)', () => {
  it('keeps the company, its address, trade register, bank account, legal lines, terms and stamp duty, and the customer\'s tax number', async () => {
    const d = desk({ settings: { stampDuty: 1 } });

    await issue(d);

    const stored = invoicesOf(d)[0];

    expect([stored.companyName, stored.companyAddress, stored.companyTaxId, stored.companyRegistre, stored.companyRib]).toEqual([
      'Smart-Dépannage SARL',
      '12 Avenue Habib Bourguiba, 1001 Tunis',
      '1234567/A/M/000',
      'B01234562026',
      '08006012345678901234',
    ]);
    expect([stored.legalMentions, stored.paymentTerms, num(stored.stampDuty)]).toEqual(['Société à responsabilité limitée au capital de 10 000 TND.', 'Paiement à réception de la facture.', 1]);
    expect(stored.clientName).toBe('Amine Ben Salah');
    expect(stored.clientTaxId).toBe('7654321/B/A/000');
    expect(stored.issuedAt).toBeInstanceOf(Date);
  });

  it('reads the same later, whatever the settings become', async () => {
    const d = desk({ settings: { stampDuty: 1 } });
    const made = await issue(d);

    const before = (await d.world.svc.invoices.pdfOfInvoice(asAdmin(d), made.id)).buffer;

    d.world.memory.rows('companySettings')[0].companyAddress = 'Une autre adresse';
    d.world.memory.rows('companySettings')[0].invoiceLegalMentions = 'Autres mentions';
    d.world.memory.rows('companySettings')[0].stampDuty = new Decimal('5');
    d.world.memory.rows('companySettings')[0].rib = '08006099999999999999';

    const after = (await d.world.svc.invoices.pdfOfInvoice(asAdmin(d), made.id)).buffer;

    expect(after.equals(before)).toBe(true);
    expect(invoicesOf(d)[0].companyAddress).toBe('12 Avenue Habib Bourguiba, 1001 Tunis');
  });

  it('says whether the accountant had confirmed the mentions, the VAT rates and the stamp duty', async () => {
    const unconfirmed = desk();
    const confirmed = desk({ settings: { invoiceRulesConfirmedAt: new Date('2026-10-01T09:00:00Z'), invoiceRulesConfirmedBy: 'Mme Trabelsi, expert-comptable' } });

    await issue(unconfirmed);
    await issue(confirmed);

    expect(invoicesOf(unconfirmed)[0].mentionsConfirmed).toBe(false);
    expect(invoicesOf(confirmed)[0].mentionsConfirmed).toBe(true);
  });

  it('is made with no settings at all: nothing is printed that the company did not write, and nothing is invented', async () => {
    const d = desk({ settings: null });

    await issue(d);

    const stored = invoicesOf(d)[0];

    expect([stored.companyAddress ?? null, stored.companyRegistre ?? null, stored.legalMentions ?? null, stored.paymentTerms ?? null, num(stored.stampDuty)]).toEqual([null, null, null, null, 0]);
    expect(stored.mentionsConfirmed).toBe(false);
  });

  it('gives the lines of the quote, or one line for the service when there are none, with the trade written out', async () => {
    const d = desk();

    await issue(d);

    const [line] = rows(d, 'invoiceItem');

    expect(line.label).toBe('Plomberie');
  });
});

describe('an invoice is paid only when the payments cover what is to be paid on it (P2-07)', () => {
  it('a deposit does not pay it: the rest does, and the day it was paid is kept', async () => {
    const d = desk({ amount: 100, taxRate: 20 });
    const made = await issue(d);

    await pay(d, 40);
    expect(invoicesOf(d)[0].status).not.toBe('PAID');
    expect(invoicesOf(d)[0].paymentStatus).not.toBe('PAID');

    await pay(d, 80);
    expect(invoicesOf(d)[0].status).toBe('PAID');
    expect(invoicesOf(d)[0].paymentStatus).toBe('PAID');
    expect(invoicesOf(d)[0].paidAt).toBeInstanceOf(Date);
    expect(invoicesOf(d)[0].id).toBe(made.id);
  });

  it('counts the stamp duty: 119 does not pay an invoice of 119 with a stamp duty of 1', async () => {
    const d = desk({ amount: 100, taxRate: 19, settings: { stampDuty: 1 } });

    await issue(d);
    await pay(d, 119);
    expect(invoicesOf(d)[0].status).not.toBe('PAID');

    await pay(d, 1);
    expect(invoicesOf(d)[0].status).toBe('PAID');
  });

  it('is paid at once when what was received before the invoice already covers it, and the payment is linked to it', async () => {
    const d = desk({ amount: 100, taxRate: 20 });
    const early = await pay(d, 120);

    await issue(d);

    expect(invoicesOf(d)[0].status).toBe('PAID');
    expect(rows(d, 'payment').find((row) => row.id === early)!.invoiceId).toBe(invoicesOf(d)[0].id);
  });

  it('is not paid again by a payment that was given back in full', async () => {
    const d = desk({ amount: 100, taxRate: 20 });
    const first = await pay(d, 120);

    await d.world.svc.payments.refund(first, d.admin.id, {});
    await issue(d);

    expect(invoicesOf(d)[0].status).not.toBe('PAID');
    // It paid nothing, so it is not moved to the invoice either.
    expect(rows(d, 'payment').find((row) => row.id === first)!.invoiceId ?? null).toBeNull();
  });

  it('goes back to unpaid when a refund leaves less than is due, and is paid again with the credit note that matches the refund', async () => {
    const d = desk({ amount: 100, taxRate: 20 });
    const first = await pay(d, 120);

    await issue(d);
    expect(invoicesOf(d)[0].status).toBe('PAID');

    await d.world.svc.payments.refund(first, d.admin.id, { amount: 20 });
    expect(invoicesOf(d)[0].status).not.toBe('PAID');
    expect(invoicesOf(d)[0].paidAt ?? null).toBeNull();

    await d.world.svc.invoices.createCreditNote(asAdmin(d), invoicesOf(d)[0].id, { reason: 'Remise accordée', amountTTC: 20 });
    expect(invoicesOf(d)[0].status).toBe('PAID');
    expect(invoicesOf(d)[0].paidAt).toBeInstanceOf(Date);
  });

  it('does not pay an invoice for the payments of another job', async () => {
    const d = desk({ amount: 100, taxRate: 20 });
    const other = d.newJob();

    await pay(d, 120, other.id);
    await issue(d);

    expect(invoicesOf(d)[0].status).not.toBe('PAID');
  });

  it('asks the customer for what is left after the credit notes, with the stamp duty', async () => {
    const d = desk({ amount: 100, taxRate: 20, settings: { stampDuty: 1 } });
    const made = await issue(d);

    await d.world.svc.invoices.createCreditNote(asAdmin(d), made.id, { reason: 'Remise', amountTTC: 20 });

    const position = await d.world.svc.payments.createClientPaymentRequest(d.client.id, d.job.id, { method: 'CASH' } as any);

    expect(num(position.amount)).toBe(101);
  });
});

describe('a credit note takes back all or part of an invoice (P2-07)', () => {
  it('takes back all of an invoice that was not paid: its own number, the invoice is cancelled, and a new invoice can be made', async () => {
    const d = desk({ amount: 100, taxRate: 19, settings: { stampDuty: 1 } });
    const made = await issue(d);
    const answer = await d.world.svc.invoices.createCreditNote(asAccountant(d), made.id, { reason: 'Intervention annulée avant les travaux' });
    const note = creditNotesOf(d)[0];

    expect(answer.creditNote.creditNoteNumber).toBe(`AV-${YEAR}-0001`);
    expect([num(note.amountHT), num(note.taxAmount), num(note.amountTTC), num(note.stampDuty)]).toEqual([100, 19, 119, 1]);
    expect([note.numberYear, note.sequence, note.reason, note.createdById]).toEqual([YEAR, 1, 'Intervention annulée avant les travaux', d.accountant.id]);
    expect(invoicesOf(d)[0].status).toBe('CANCELLED');
    expect(num(invoicesOf(d)[0].creditedAmount)).toBe(120);
    expect(invoicesOf(d)[0].cancelReason).toBe(`Avoir AV-${YEAR}-0001`);
    expect(answer.refundToMake).toBe(0);

    const replacement = await issue(d);

    expect(replacement.invoiceNumber).toBe(`F-${YEAR}-0002`);
    expect(audit(d.world).ok).toBe(true);
  });

  it('takes back part of an invoice: it stays out, for less; the stamp duty is taken back only with the last credit note', async () => {
    const d = desk({ amount: 100, taxRate: 20, settings: { stampDuty: 1 } });
    const made = await issue(d);

    await d.world.svc.invoices.createCreditNote(asAdmin(d), made.id, { reason: 'Remise', amountTTC: 20 });

    const [first] = creditNotesOf(d);

    expect([num(first.amountTTC), num(first.amountHT), num(first.taxAmount), num(first.stampDuty)]).toEqual([20, 16.667, 3.333, 0]);
    expect(invoicesOf(d)[0].status).not.toBe('CANCELLED');
    expect(num(invoicesOf(d)[0].creditedAmount)).toBe(20);

    // What is left is 100 and the stamp duty of 1: taking all of it back closes the invoice, stamp duty included.
    await d.world.svc.invoices.createCreditNote(asAdmin(d), made.id, { reason: 'Reste' });

    const second = creditNotesOf(d)[1];

    expect([num(second.amountTTC), num(second.stampDuty)]).toEqual([100, 1]);
    expect(invoicesOf(d)[0].status).toBe('CANCELLED');
    expect(num(invoicesOf(d)[0].creditedAmount)).toBe(121);
  });

  it('refuses more than is left, nothing, a negative amount, a missing or too long reason: nothing is written and no number is used', async () => {
    const d = desk({ amount: 100, taxRate: 20 });
    const made = await issue(d);
    const credit = (dto: Record<string, unknown>) => refusal(() => d.world.svc.invoices.createCreditNote(asAdmin(d), made.id, dto as any));

    expect((await credit({ reason: 'Trop', amountTTC: 120.001 }))?.status).toBe(400);
    expect((await credit({ reason: 'Zéro', amountTTC: 0 }))?.status).toBe(400);
    expect((await credit({ reason: 'Moins', amountTTC: -5 }))?.status).toBe(400);
    expect((await credit({ amountTTC: 5 }))?.status).toBe(400);
    expect((await credit({ reason: '   ', amountTTC: 5 }))?.status).toBe(400);
    expect((await credit({ reason: 'x'.repeat(501), amountTTC: 5 }))?.status).toBe(400);
    expect(creditNotesOf(d)).toEqual([]);
    expect(rows(d, 'documentCounter').map((row) => row.series)).toEqual(['INVOICE']);
    expect(num(invoicesOf(d)[0].creditedAmount)).toBe(0);
  });

  it('refuses what is left of an invoice that was all taken back', async () => {
    const d = desk({ amount: 100, taxRate: 20 });
    const made = await issue(d);

    await d.world.svc.invoices.createCreditNote(asAdmin(d), made.id, { reason: 'Tout' });

    const again = await refusal(() => d.world.svc.invoices.createCreditNote(asAdmin(d), made.id, { reason: 'Encore', amountTTC: 1 }));

    expect(again?.status).toBe(400);
    expect(creditNotesOf(d)).toHaveLength(1);
  });

  it('is only for an invoice that is out: not a draft, not one that was cancelled', async () => {
    const d = desk();
    const made = await issue(d);

    d.world.memory.rows('invoice')[0].status = 'DRAFT';
    expect((await refusal(() => d.world.svc.invoices.createCreditNote(asAdmin(d), made.id, { reason: 'Non' })))?.status).toBe(400);

    d.world.memory.rows('invoice')[0].status = 'CANCELLED';
    expect((await refusal(() => d.world.svc.invoices.createCreditNote(asAdmin(d), made.id, { reason: 'Non' })))?.status).toBe(400);
    expect(creditNotesOf(d)).toEqual([]);
  });

  it('is for the back office: the customer, another customer and the artisan are refused', async () => {
    const d = desk();
    const made = await issue(d);

    for (const who of [asClient(d), asStranger(d), asArtisan(d)]) {
      expect((await refusal(() => d.world.svc.invoices.createCreditNote(who, made.id, { reason: 'Non' })))?.status).toBe(403);
    }

    expect(creditNotesOf(d)).toEqual([]);
  });

  it('has a number of its own series: AV-2026-0001, 0002 even while invoices go on', async () => {
    const d = desk();
    const second = d.newJob();
    const a = await issue(d);

    await d.world.svc.invoices.createCreditNote(asAdmin(d), a.id, { reason: 'Un', amountTTC: 10 });
    await issue(d, second.id);
    await d.world.svc.invoices.createCreditNote(asAdmin(d), a.id, { reason: 'Deux', amountTTC: 10 });

    expect(creditNotesOf(d).map((row) => row.creditNoteNumber)).toEqual([`AV-${YEAR}-0001`, `AV-${YEAR}-0002`]);
    expect(invoicesOf(d).map((row) => row.invoiceNumber)).toEqual([`F-${YEAR}-0001`, `F-${YEAR}-0002`]);
  });

  it('two credit notes at the same moment on one invoice cannot take more than the invoice holds', async () => {
    const d = desk({ amount: 100, taxRate: 20 });
    const made = await issue(d);
    const results = await Promise.all([
      refusal(() => d.world.svc.invoices.createCreditNote(asAdmin(d), made.id, { reason: 'A', amountTTC: 80 })),
      refusal(() => d.world.svc.invoices.createCreditNote(asAdmin(d), made.id, { reason: 'B', amountTTC: 80 })),
    ]);

    expect(results.filter((result) => result === null)).toHaveLength(1);
    expect(results.filter((result) => result?.status === 400)).toHaveLength(1);
    expect(creditNotesOf(d)).toHaveLength(1);
    expect(num(invoicesOf(d)[0].creditedAmount)).toBe(80);
    expect(audit(d.world).ok).toBe(true);
  });

  it('two credit notes at the same moment that both fit are both made, and the invoice has been credited for both', async () => {
    const d = desk({ amount: 100, taxRate: 20 });
    const made = await issue(d);
    const results = await Promise.all([
      refusal(() => d.world.svc.invoices.createCreditNote(asAdmin(d), made.id, { reason: 'A', amountTTC: 30 })),
      refusal(() => d.world.svc.invoices.createCreditNote(asAdmin(d), made.id, { reason: 'B', amountTTC: 30 })),
    ]);

    expect(results).toEqual([null, null]);
    expect(creditNotesOf(d).map((row) => row.creditNoteNumber)).toEqual([`AV-${YEAR}-0001`, `AV-${YEAR}-0002`]);
    expect(num(invoicesOf(d)[0].creditedAmount)).toBe(60);
    expect(audit(d.world).ok).toBe(true);
  });

  it('on an invoice that was paid: a part leaves it paid, and says how much to give back', async () => {
    const d = desk({ amount: 100, taxRate: 20 });
    const first = await pay(d, 120);
    const made = await issue(d);

    expect(invoicesOf(d)[0].status).toBe('PAID');

    const answer = await d.world.svc.invoices.createCreditNote(asAdmin(d), made.id, { reason: 'Remise après coup', amountTTC: 20 });

    expect(invoicesOf(d)[0].status).toBe('PAID');
    expect(answer.refundToMake).toBe(20);

    // The refund is made in the usual way: the invoice, now for 100, stays paid.
    await d.world.svc.payments.refund(first, d.admin.id, { amount: 20 });

    expect(invoicesOf(d)[0].status).toBe('PAID');
  });

  it('on an invoice that was paid: all of it closes the invoice, and the whole payment is to be given back', async () => {
    const d = desk({ amount: 100, taxRate: 20 });

    await pay(d, 120);

    const made = await issue(d);
    const answer = await d.world.svc.invoices.createCreditNote(asAdmin(d), made.id, { reason: 'Travaux non conformes' });

    expect(invoicesOf(d)[0].status).toBe('CANCELLED');
    expect(answer.refundToMake).toBe(120);
  });

  it('tells the timeline that there is one, without the reason the customer reads on the document', async () => {
    const d = desk();
    const made = await issue(d);

    await d.world.svc.invoices.createCreditNote(asAdmin(d), made.id, { reason: 'Motif très personnel du client' });

    const line = rows(d, 'interventionEvent').find((event) => event.title === 'Avoir émis');

    expect(line?.message).toContain(`AV-${YEAR}-0001`);
    expect(JSON.stringify([line?.title, line?.message])).not.toContain('personnel');
    expect(line?.metadata.closesInvoice).toBe(true);
  });

  it('shows the customer the credit notes of their invoice, and the artisan too, without who wrote them', async () => {
    const d = desk();
    const made = await issue(d);

    await d.world.svc.invoices.createCreditNote(asAdmin(d), made.id, { reason: 'Geste', amountTTC: 10 });

    const mine: any = await d.world.svc.invoices.findOneForClient(d.client.id, made.id);
    const theirs: any = await d.world.svc.invoices.findOne(asArtisan(d), made.id);

    for (const view of [mine, theirs]) {
      expect(view.creditNotes).toHaveLength(1);
      expect(view.creditNotes[0].creditNoteNumber).toBe(`AV-${YEAR}-0001`);
      expect(view.creditNotes[0]).not.toHaveProperty('createdById');
      expect(num(view.creditedAmount)).toBe(10);
    }

    // The reason is written for the customer; the artisan reads the amounts.
    expect(mine.creditNotes[0].reason).toBe('Geste');
    expect(theirs.creditNotes[0]).not.toHaveProperty('reason');
  });
});

describe('an invoice that is paid, or has a credit note, is not cancelled (P2-07)', () => {
  it('refuses to cancel a paid invoice, and says to issue a credit note', async () => {
    const d = desk({ amount: 100, taxRate: 20 });

    await pay(d, 120);

    const made = await issue(d);
    const refused = await refusal(() => d.world.svc.invoices.cancelInvoice(asAdmin(d), made.id, { reason: 'Erreur' }));

    expect(refused?.status).toBe(400);
    expect(refused?.message).toContain('avoir');
    expect(invoicesOf(d)[0].status).toBe('PAID');
  });

  it('refuses to cancel an invoice that has a credit note, or that is cancelled already', async () => {
    const d = desk();
    const made = await issue(d);

    await d.world.svc.invoices.createCreditNote(asAdmin(d), made.id, { reason: 'Geste', amountTTC: 10 });
    expect((await refusal(() => d.world.svc.invoices.cancelInvoice(asAdmin(d), made.id, { reason: 'Non' })))?.status).toBe(400);

    const other = desk();
    const second = await issue(other);

    await other.world.svc.invoices.cancelInvoice(asAdmin(other), second.id, { reason: 'Oui' });
    expect((await refusal(() => other.world.svc.invoices.cancelInvoice(asAdmin(other), second.id, { reason: 'Encore' })))?.message).toContain('déjà annulée');
  });

  it('cancels an invoice nobody paid, and the job asks for its quote again', async () => {
    const d = desk({ amount: 100, taxRate: 20 });
    const made = await issue(d);

    await d.world.svc.invoices.cancelInvoice(asAdmin(d), made.id, { reason: 'Erreur de montant' });

    expect(invoicesOf(d)[0].status).toBe('CANCELLED');
    expect(invoicesOf(d)[0].cancelReason).toBe('Erreur de montant');
  });
});

describe('an invoice that is cancelled while something else happens to it (P2-07)', () => {
  it('is not cancelled by a request that waited for a credit note on the same invoice: the credit note was first', async () => {
    const d = desk();
    const made = await issue(d);
    const [credit, cancel] = await Promise.all([
      refusal(() => d.world.svc.invoices.createCreditNote(asAdmin(d), made.id, { reason: 'Geste', amountTTC: 10 })),
      refusal(() => d.world.svc.invoices.cancelInvoice(asAdmin(d), made.id, { reason: 'Erreur' })),
    ]);

    expect(credit).toBeNull();
    expect(cancel?.status).toBe(400);
    expect(invoicesOf(d)[0].status).not.toBe('CANCELLED');
    expect(creditNotesOf(d)).toHaveLength(1);
  });

  it('takes no payment link: a payment is linked to the invoice that is out, not to one that was cancelled', async () => {
    const d = desk({ amount: 100, taxRate: 20 });
    const first = await issue(d);

    await d.world.svc.invoices.cancelInvoice(asAdmin(d), first.id, { reason: 'Erreur' });

    const second = await issue(d);
    const paid = await pay(d, 40);
    const toCancelled = await refusal(() => d.world.svc.payments.linkToInvoice(paid, first.id));
    const toLive = await refusal(() => d.world.svc.payments.linkToInvoice(paid, second.id));

    expect(toCancelled?.status).toBe(400);
    expect(toLive).toBeNull();
    expect(rows(d, 'payment').find((row) => row.id === paid)!.invoiceId).toBe(second.id);
  });
});

describe('the PDF of an invoice and of a credit note (P2-07)', () => {
  const textOf = (buffer: Buffer) => buffer.toString('latin1');

  it('is a PDF that carries the number, the mentions of the company and the totals', async () => {
    const d = desk({ amount: 100, taxRate: 19, settings: { stampDuty: 1 } });
    const made = await issue(d);
    const file = await d.world.svc.invoices.pdfOfInvoice(asClient(d), made.id);
    const content = textOf(file.buffer);

    expect(file.filename).toBe(`F-${YEAR}-0001.pdf`);
    expect(content.startsWith('%PDF-1.4')).toBe(true);
    for (const wanted of [`N\\260 F-${YEAR}-0001`, 'MF : 1234567/A/M/000', 'RC : B01234562026', '12 Avenue Habib Bourguiba, 1001 Tunis', 'Soci\\351t\\351 \\340 responsabilit\\351 limit\\351e', '120,000 TND', 'Timbre fiscal', 'Cent vingt dinars', 'MF : 7654321/B/A/000']) {
      expect(content).toContain(wanted);
    }
  });

  it('is for the customer and the back office, not for another customer or the artisan, and not for a draft', async () => {
    const d = desk();
    const made = await issue(d);

    expect((await d.world.svc.invoices.pdfOfInvoice(asAdmin(d), made.id)).buffer.length).toBeGreaterThan(500);
    expect((await d.world.svc.invoices.pdfOfInvoice(asAccountant(d), made.id)).buffer.length).toBeGreaterThan(500);
    expect((await refusal(() => d.world.svc.invoices.pdfOfInvoice(asStranger(d), made.id)))?.status).toBe(403);
    expect((await refusal(() => d.world.svc.invoices.pdfOfInvoice(asArtisan(d), made.id)))?.status).toBe(403);
    expect((await refusal(() => d.world.svc.invoices.pdfOfInvoice(asClient(d), 999)))?.status).toBe(404);

    d.world.memory.rows('invoice')[0].status = 'DRAFT';
    expect((await refusal(() => d.world.svc.invoices.pdfOfInvoice(asClient(d), made.id)))?.status).toBe(404);
    expect((await d.world.svc.invoices.pdfOfInvoice(asAdmin(d), made.id)).buffer.length).toBeGreaterThan(500);
  });

  it('is the same bytes each time it is asked for', async () => {
    const d = desk();
    const made = await issue(d);
    const first = await d.world.svc.invoices.pdfOfInvoice(asClient(d), made.id);
    const second = await d.world.svc.invoices.pdfOfInvoice(asClient(d), made.id);

    expect(first.buffer.equals(second.buffer)).toBe(true);
  });

  it('shows the credit notes taken off it, and the credit note has its own PDF with the same access', async () => {
    const d = desk({ amount: 100, taxRate: 19 });
    const made = await issue(d);

    await d.world.svc.invoices.createCreditNote(asAdmin(d), made.id, { reason: 'Prestation partielle', amountTTC: 19 });

    const invoicePdf = textOf((await d.world.svc.invoices.pdfOfInvoice(asClient(d), made.id)).buffer);
    const note = creditNotesOf(d)[0];
    const creditPdf = await d.world.svc.invoices.pdfOfCreditNote(asClient(d), note.id);
    const content = textOf(creditPdf.buffer);

    expect(invoicePdf).toContain(`Avoir AV-${YEAR}-0001`);
    expect(invoicePdf).toContain('Net \\340 payer');
    expect(creditPdf.filename).toBe(`AV-${YEAR}-0001.pdf`);
    expect(content).toContain('Motif : Prestation partielle');
    expect(content).toContain('- 19,000 TND');
    expect((await refusal(() => d.world.svc.invoices.pdfOfCreditNote(asStranger(d), note.id)))?.status).toBe(403);
    expect((await refusal(() => d.world.svc.invoices.pdfOfCreditNote(asArtisan(d), note.id)))?.status).toBe(403);
    expect((await refusal(() => d.world.svc.invoices.pdfOfCreditNote(asClient(d), 999)))?.status).toBe(404);
  });

  it('is sent as a PDF to be opened in the browser, not kept by a cache, not read as anything else', async () => {
    const headers: Record<string, string> = {};
    let body: unknown;

    sendPdf({ setHeader: (name, value) => void (headers[name] = value), send: (value) => void (body = value) }, { buffer: Buffer.from('%PDF-1.4'), filename: 'F-2026-0001.pdf' });

    expect(headers).toEqual({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="F-2026-0001.pdf"',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    expect(Buffer.isBuffer(body)).toBe(true);
  });
});

describe('the link of a job opens the PDF of its invoice (P2-07)', () => {
  const linkOf = (d: Desk) => {
    d.world.memory.rows('intervention')[0].trackingToken = require('crypto').createHash('sha256').update('raw-link-0001').digest('hex');

    return 'raw-link-0001';
  };

  it('is served to the holder of the link, for the invoice that is out', async () => {
    const d = desk();
    const token = linkOf(d);

    await issue(d);

    const file = await d.world.svc.guest.invoicePdf(d.job.id, token);

    expect(file.filename).toBe(`F-${YEAR}-0001.pdf`);
    expect(file.buffer.toString('latin1').startsWith('%PDF-1.4')).toBe(true);
  });

  it('is refused for a wrong link, and is not there for a draft or a job that has no invoice', async () => {
    const d = desk();
    const token = linkOf(d);

    expect((await refusal(() => d.world.svc.guest.invoicePdf(d.job.id, token)))?.status).toBe(404);

    await issue(d);

    expect((await refusal(() => d.world.svc.guest.invoicePdf(d.job.id, 'not-the-link')))?.status).toBe(404);
    expect((await refusal(() => d.world.svc.guest.invoicePdf(d.job.id, undefined as any)))?.status).toBe(404);

    d.world.memory.rows('invoice')[0].status = 'DRAFT';
    expect((await refusal(() => d.world.svc.guest.invoicePdf(d.job.id, token)))?.status).toBe(404);
  });

  it('serves the credit note of the job, and nothing for a credit note that is not on this job', async () => {
    const d = desk();
    const token = linkOf(d);
    const made = await issue(d);

    await d.world.svc.invoices.createCreditNote(asAdmin(d), made.id, { reason: 'Geste', amountTTC: 10 });

    const note = creditNotesOf(d)[0];
    const file = await d.world.svc.guest.creditNotePdf(d.job.id, token, note.id);

    expect(file.filename).toBe(`AV-${YEAR}-0001.pdf`);
    expect((await refusal(() => d.world.svc.guest.creditNotePdf(d.job.id, token, 999)))?.status).toBe(404);
    expect((await refusal(() => d.world.svc.guest.creditNotePdf(d.job.id, 'not-the-link', note.id)))?.status).toBe(404);
  });

  it('serves the credit note of an invoice that was cancelled by it (the job has a new invoice by then)', async () => {
    const d = desk();
    const token = linkOf(d);
    const made = await issue(d);

    await d.world.svc.invoices.createCreditNote(asAdmin(d), made.id, { reason: 'Tout' });
    await issue(d);

    const file = await d.world.svc.guest.creditNotePdf(d.job.id, token, creditNotesOf(d)[0].id);

    expect(file.filename).toBe(`AV-${YEAR}-0001.pdf`);
    expect((await d.world.svc.guest.invoicePdf(d.job.id, token)).filename).toBe(`F-${YEAR}-0002.pdf`);
  });
});

describe('the settings the invoices print, and the accountant\'s confirmation (P2-07)', () => {
  const settingsOf = (d: Desk) => rows(d, 'companySettings')[0];
  const update = (d: Desk, dto: Record<string, unknown>) => d.world.svc.admin.updateCompanySettings(dto as any);

  it('are written and read back: address, trade register, legal lines, terms, stamp duty', async () => {
    const d = desk({ settings: null });

    await update(d, {
      companyAddress: ' 12 Avenue Habib Bourguiba, Tunis ',
      registreCommerce: 'B01234562026',
      invoiceLegalMentions: 'SARL au capital de 10 000 TND.',
      paymentTerms: 'Paiement à 30 jours.',
      stampDuty: 1,
    });

    const row = settingsOf(d);

    expect([row.companyAddress, row.registreCommerce, row.invoiceLegalMentions, row.paymentTerms, num(row.stampDuty)]).toEqual([
      '12 Avenue Habib Bourguiba, Tunis',
      'B01234562026',
      'SARL au capital de 10 000 TND.',
      'Paiement à 30 jours.',
      1,
    ]);
    expect(row.invoiceRulesConfirmedAt ?? null).toBeNull();
  });

  it('are cleared by an empty text', async () => {
    const d = desk();

    await update(d, { companyAddress: '  ', registreCommerce: '', invoiceLegalMentions: null, paymentTerms: '' });

    const row = settingsOf(d);

    expect([row.companyAddress, row.registreCommerce, row.invoiceLegalMentions, row.paymentTerms]).toEqual([null, null, null, null]);
  });

  it('are confirmed by the accountant: the request says who, and the confirmation has a date', async () => {
    const d = desk();

    await update(d, { invoiceRulesConfirmed: true, invoiceRulesConfirmedBy: 'Mme Trabelsi, expert-comptable' });

    expect(settingsOf(d).invoiceRulesConfirmedAt).toBeInstanceOf(Date);
    expect(settingsOf(d).invoiceRulesConfirmedBy).toBe('Mme Trabelsi, expert-comptable');
  });

  it('are not confirmed without a name, and a name alone confirms nothing', async () => {
    const d = desk();

    expect((await refusal(() => update(d, { invoiceRulesConfirmed: true })))?.status).toBe(400);
    expect((await refusal(() => update(d, { invoiceRulesConfirmed: true, invoiceRulesConfirmedBy: '   ' })))?.status).toBe(400);
    expect((await refusal(() => update(d, { invoiceRulesConfirmedBy: 'Mme Trabelsi' })))?.status).toBe(400);
    expect(settingsOf(d).invoiceRulesConfirmedAt ?? null).toBeNull();
  });

  it('lose their confirmation when something an invoice prints changes, because the accountant did not see the new value', async () => {
    const changes: Array<Record<string, unknown>> = [
      { companyAddress: 'Une autre adresse' },
      { registreCommerce: 'B99999992026' },
      { invoiceLegalMentions: 'Autres mentions' },
      { paymentTerms: 'À 60 jours' },
      { stampDuty: 2 },
      { defaultTaxRate: 13 },
      { rib: '08006099999999999999' },
      { matriculeFiscal: '7654321/B/A/000' },
      { companyName: 'Autre nom' },
      { taxRates: [{ code: 'STANDARD', label: 'TVA 19 %', rate: 19 }, { code: 'EXEMPT', label: 'Exonéré', rate: 0 }] },
    ];

    for (const change of changes) {
      const d = desk({ settings: { invoiceRulesConfirmedAt: new Date('2026-10-01T09:00:00Z'), invoiceRulesConfirmedBy: 'Mme Trabelsi', stampDuty: 1 } });

      await update(d, change);

      expect(`${JSON.stringify(change)} -> ${settingsOf(d).invoiceRulesConfirmedAt ?? null}`).toBe(`${JSON.stringify(change)} -> null`);
      expect(settingsOf(d).invoiceRulesConfirmedBy ?? null).toBeNull();
    }
  });

  it('keep their confirmation when the request says the same again, or changes what no invoice prints', async () => {
    const d = desk({ settings: { invoiceRulesConfirmedAt: new Date('2026-10-01T09:00:00Z'), invoiceRulesConfirmedBy: 'Mme Trabelsi', stampDuty: 1 } });

    await update(d, { companyAddress: '12 Avenue Habib Bourguiba, 1001 Tunis', stampDuty: 1, paymentTerms: ' Paiement à réception de la facture. ', smsSender: 'AUTRE' });

    expect(settingsOf(d).invoiceRulesConfirmedAt).toBeInstanceOf(Date);
    expect(settingsOf(d).invoiceRulesConfirmedBy).toBe('Mme Trabelsi');
  });

  it('are confirmed again, with the new values, in the same request that changes them', async () => {
    const d = desk({ settings: { invoiceRulesConfirmedAt: new Date('2026-10-01T09:00:00Z'), invoiceRulesConfirmedBy: 'Mme Trabelsi' } });

    await update(d, { stampDuty: 1, invoiceRulesConfirmed: true, invoiceRulesConfirmedBy: 'M. Gharbi' });

    expect(num(settingsOf(d).stampDuty)).toBe(1);
    expect(settingsOf(d).invoiceRulesConfirmedBy).toBe('M. Gharbi');
    expect(settingsOf(d).invoiceRulesConfirmedAt).toBeInstanceOf(Date);
  });

  it('can be taken back: confirmed false clears it', async () => {
    const d = desk({ settings: { invoiceRulesConfirmedAt: new Date('2026-10-01T09:00:00Z'), invoiceRulesConfirmedBy: 'Mme Trabelsi' } });

    await update(d, { invoiceRulesConfirmed: false });

    expect(settingsOf(d).invoiceRulesConfirmedAt ?? null).toBeNull();
    expect(settingsOf(d).invoiceRulesConfirmedBy ?? null).toBeNull();
  });

  it('refuse a stamp duty that is a typing error', async () => {
    const d = desk();
    const refused = await refusal(() => update(d, { stampDuty: 1000 }));

    expect(refused?.status).toBe(400);
    expect(num(settingsOf(d).stampDuty)).toBe(0);
  });

  it('are what the next invoice prints, and the invoices before it keep what they printed', async () => {
    const d = desk({ settings: { stampDuty: 0 } });
    const second = d.newJob();

    await issue(d);
    await update(d, { stampDuty: 1, paymentTerms: 'Paiement à 30 jours.' });
    await issue(d, second.id);

    expect(invoicesOf(d).map((row) => [num(row.stampDuty), row.paymentTerms])).toEqual([[0, 'Paiement à réception de la facture.'], [1, 'Paiement à 30 jours.']]);
  });
});

describe('who may call the routes of the invoice PDFs and of the credit notes (P2-07)', () => {
  const routesOf = (file: string) => {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');

    return Object.fromEntries(scanController(source, TICKET_STAFF_ROLES).map((route) => [routeKey(route.method, route.path), route]));
  };
  const STAFF = ['ADMIN', 'SUPER_ADMIN', 'SUPPORT', 'DISPATCHER', 'ACCOUNTANT'];

  it('a credit note is issued by the administrators and the accountant, not by support or the dispatcher', () => {
    const route = routesOf('invoices.controller.ts')['POST /invoices/:/credit-notes'];

    expect(route.roles).toEqual(['ADMIN', 'SUPER_ADMIN', 'ACCOUNTANT']);
    expect(route.rolesEnforced).toBe(true);
  });

  it('the PDF of an invoice and of a credit note is asked for by signed-in people of every role (the service says whose it is)', () => {
    const routes = routesOf('invoices.controller.ts');

    for (const key of ['GET /invoices/:/pdf', 'GET /invoices/credit-notes/:/pdf']) {
      expect([...(routes[key].roles ?? [])].sort()).toEqual(['ARTISAN', 'CLIENT', ...STAFF].sort());
      expect(routes[key].rolesEnforced).toBe(true);
    }
  });

  it('the PDF of the link of a request is public, and counted per visitor', () => {
    const routes = routesOf('../guest/guest.controller.ts');

    for (const key of ['GET /guest/interventions/:/invoice/pdf', 'GET /guest/interventions/:/credit-notes/:/pdf']) {
      expect(routes[key].how).toBe('public');
      expect(routes[key].guards).toContain('RateLimitGuard');
    }
  });
});

describe('the confirmation of the mentions, after the review (P2-07)', () => {
  const settingsOf = (d: Desk) => rows(d, 'companySettings')[0];
  const update = (d: Desk, dto: Record<string, unknown>) => d.world.svc.admin.updateCompanySettings(dto as any);
  const confirmed = { invoiceRulesConfirmedAt: new Date('2026-10-01T09:00:00Z'), invoiceRulesConfirmedBy: 'Mme Trabelsi' };
  const confirm = { invoiceRulesConfirmed: true, invoiceRulesConfirmedBy: 'Mme Trabelsi, expert-comptable' };

  it('is refused on settings that say neither where the company is nor its tax number: there is nothing to confirm', async () => {
    const d = desk({ settings: null });
    const refused = await refusal(() => update(d, confirm));

    expect(refused?.status).toBe(400);
    expect(refused?.message).toContain('l’adresse');
    expect(refused?.message).toContain('le matricule fiscal');
    expect(refused?.message).not.toContain('le nom');
    expect(settingsOf(d).invoiceRulesConfirmedAt ?? null).toBeNull();
  });

  it('is refused for what is still missing, and only that', async () => {
    const d = desk({ settings: null });

    await update(d, { companyAddress: '12 Avenue Habib Bourguiba, 1001 Tunis' });

    const refused = await refusal(() => update(d, confirm));

    expect(refused?.status).toBe(400);
    expect(refused?.message).toContain('le matricule fiscal');
    expect(refused?.message).not.toContain('l’adresse');
  });

  it('is given in the request that brings what was missing', async () => {
    const d = desk({ settings: null });

    await update(d, { ...confirm, companyAddress: '12 Avenue Habib Bourguiba, 1001 Tunis', matriculeFiscal: '7654321/B/A/000' });

    expect(settingsOf(d).invoiceRulesConfirmedAt).toBeInstanceOf(Date);
    expect(settingsOf(d).invoiceRulesConfirmedBy).toBe('Mme Trabelsi, expert-comptable');
  });

  it('is refused when the same request empties the name, the address or the tax number, and nothing of that request is written', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      // (P2-09: a name is never emptied, with or without a confirmation; the refusal comes before the confirmation is looked at)
      [{ companyName: '  ' }, 'le nom de l’entreprise'],
      [{ companyAddress: ' ' }, 'l’adresse'],
      [{ matriculeFiscal: '' }, 'le matricule fiscal'],
      [{ companyAddress: null }, 'l’adresse'],
    ];

    for (const [change, missing] of cases) {
      const d = desk();
      const refused = await refusal(() => update(d, { ...confirm, ...change, paymentTerms: 'À 45 jours' }));

      expect(`${JSON.stringify(change)} -> ${refused?.status} ${refused?.message?.toLowerCase().includes(missing)}`).toBe(`${JSON.stringify(change)} -> 400 true`);
      expect(settingsOf(d).paymentTerms).toBe('Paiement à réception de la facture.');
      expect(settingsOf(d).invoiceRulesConfirmedAt ?? null).toBeNull();
    }
  });

  it('is kept when the list of VAT rates is sent again with the keys of each rate in another order', async () => {
    const d = desk({
      settings: { ...confirmed, defaultTaxRate: 19, taxRates: [{ rate: 19, label: 'TVA 19 %', code: 'STANDARD' }, { rate: 0, label: 'Exonéré', code: 'EXEMPT' }] },
    });

    await update(d, { taxRates: [{ code: 'STANDARD', label: 'TVA 19 %', rate: 19 }, { code: 'EXEMPT', label: 'Exonéré', rate: 0 }] });

    expect(settingsOf(d).invoiceRulesConfirmedAt).toBeInstanceOf(Date);
    expect(settingsOf(d).invoiceRulesConfirmedBy).toBe('Mme Trabelsi');
  });

  it('is taken away when a rate of that list really changes', async () => {
    const d = desk({
      settings: { ...confirmed, defaultTaxRate: 19, taxRates: [{ rate: 19, label: 'TVA 19 %', code: 'STANDARD' }, { rate: 0, label: 'Exonéré', code: 'EXEMPT' }] },
    });

    await update(d, { taxRates: [{ code: 'STANDARD', label: 'TVA 19 %', rate: 19 }, { code: 'EXEMPT', label: 'Exonéré', rate: 0 }, { code: 'REDUCED', label: 'TVA 7 %', rate: 7 }] });

    expect(settingsOf(d).invoiceRulesConfirmedAt ?? null).toBeNull();
  });

  it('clears the stamp duty with null: none (the column cannot be empty), and that is a change an invoice prints', async () => {
    const d = desk({ settings: { ...confirmed, stampDuty: 1 } });

    expect(await refusal(() => update(d, { stampDuty: null }))).toBeNull();
    expect(num(settingsOf(d).stampDuty)).toBe(0);
    expect(settingsOf(d).invoiceRulesConfirmedAt ?? null).toBeNull();

    const none = desk({ settings: { ...confirmed, stampDuty: 0 } });

    expect(await refusal(() => update(none, { stampDuty: null }))).toBeNull();
    expect(num(settingsOf(none).stampDuty)).toBe(0);
    expect(settingsOf(none).invoiceRulesConfirmedAt).toBeInstanceOf(Date);
  });
});

describe('an invoice made from a quote, or from an amount, after the review (P2-07)', () => {
  const confirmedSettings = { invoiceRulesConfirmedAt: new Date('2026-10-01T09:00:00Z'), invoiceRulesConfirmedBy: 'Mme Trabelsi' };

  it('does not claim the accountant\'s confirmation at a VAT rate the company does not list (a quote written before the list changed)', async () => {
    const odd = desk({ taxRate: 18, settings: confirmedSettings });
    const listed = desk({ taxRate: 19, settings: confirmedSettings });

    await issue(odd);
    await issue(listed);

    expect(num(invoicesOf(odd)[0].taxRate)).toBe(18);
    expect(invoicesOf(odd)[0].mentionsConfirmed).toBe(false);
    expect(invoicesOf(listed)[0].mentionsConfirmed).toBe(true);
  });

  async function itemsOfInvoice(dto: Record<string, unknown>): Promise<Array<[string, number, number]>> {
    const d = desk({ amount: 100, taxRate: 19 });
    const quote = rows(d, 'quote')[0];

    d.world.memory.plant('quoteItem', { quoteId: quote.id, label: 'Remplacement du siphon', quantity: 1, unitPrice: 60, total: 60 });
    d.world.memory.plant('quoteItem', { quoteId: quote.id, label: 'Main d’œuvre', quantity: 2, unitPrice: 20, total: 40 });

    await issue(d, d.job.id, dto);

    return rows(d, 'invoiceItem').map((row) => [row.label, num(row.quantity), num(row.total)]);
  }

  it('keeps the lines of the quote when it is the quote that is invoiced', async () => {
    const lines = [['Remplacement du siphon', 1, 60], ['Main d’œuvre', 2, 40]];

    expect(await itemsOfInvoice({})).toEqual(lines);
    // The same amount typed again, or only a rate: the lines still add up to the invoice.
    expect(await itemsOfInvoice({ amountHT: 100 })).toEqual(lines);
    expect(await itemsOfInvoice({ taxRate: 7 })).toEqual(lines);
  });

  it('has one line for the service when the back office types another amount: lines that add up to something else are not printed', async () => {
    expect(await itemsOfInvoice({ amountHT: 80 })).toEqual([['Plomberie', 1, 80]]);
    expect(await itemsOfInvoice({ amountHT: 100.001 })).toEqual([['Plomberie', 1, 100.001]]);
  });
});

describe('the e-mail of an invoice, after the review (P2-07)', () => {
  /** Sends the invoice; `during` runs while the e-mail is being queued (when a payment or a credit note can come in). */
  async function mail(d: Desk, invoiceId: number, during?: () => void) {
    const sent: string[] = [];

    rows(d, 'invoice').find((row) => row.id === invoiceId)!.clientEmail = 'client@example.com';
    (d.world.svc.invoices as any).notifications = {
      isEmailSimulated: () => false,
      sendEmail: async (_to: string, _subject: string, body: string) => {
        sent.push(body);
        during?.();

        return { queued: true };
      },
    };

    const answer = await d.world.svc.invoices.sendInvoiceByEmail(asAdmin(d) as any, invoiceId, {} as any);

    return { sent, answer, row: rows(d, 'invoice').find((entry) => entry.id === invoiceId)! };
  }

  it('says what the customer has to pay: the stamp duty is in it, and so are the credit notes', async () => {
    const stamped = desk({ amount: 100, taxRate: 19, settings: { stampDuty: 1 } });
    const made = await issue(stamped);
    const first = await mail(stamped, made.id);

    expect(first.sent[0]).toContain('120,000 TND TTC (timbre fiscal compris)');

    await stamped.world.svc.invoices.createCreditNote(asAdmin(stamped), made.id, { reason: 'Geste commercial', amountTTC: 19 });

    const second = await mail(stamped, made.id);

    expect(second.sent[0]).toContain('101,000 TND TTC (timbre fiscal compris)');

    const plain = desk({ amount: 100, taxRate: 19, settings: { stampDuty: 0 } });
    const third = await mail(plain, (await issue(plain)).id);

    expect(third.sent[0]).toContain('119,000 TND TTC');
    expect(third.sent[0]).not.toContain('timbre');
  });

  it('marks the invoice as sent, with the day and the address', async () => {
    const d = desk();
    const sent = await mail(d, (await issue(d)).id);

    expect(sent.row.status).toBe('SENT');
    expect(sent.row.sentAt).toBeInstanceOf(Date);
    expect(sent.row.emailedTo).toBe('client@example.com');
    expect(sent.answer.status).toBe('SENT');
  });

  it('does not undo a payment or a cancellation that came in while the e-mail was being queued', async () => {
    const paid = desk();
    const paidInvoice = await issue(paid);
    const afterPayment = await mail(paid, paidInvoice.id, () => {
      rows(paid, 'invoice').find((row) => row.id === paidInvoice.id)!.status = 'PAID';
    });

    expect(afterPayment.row.status).toBe('PAID');
    expect(afterPayment.row.sentAt).toBeInstanceOf(Date);

    const cancelled = desk();
    const cancelledInvoice = await issue(cancelled);
    const afterCredit = await mail(cancelled, cancelledInvoice.id, () => {
      rows(cancelled, 'invoice').find((row) => row.id === cancelledInvoice.id)!.status = 'CANCELLED';
    });

    expect(afterCredit.row.status).toBe('CANCELLED');
  });

  it('is not sent for an invoice that is cancelled', async () => {
    const d = desk();
    const made = await issue(d);

    await d.world.svc.invoices.cancelInvoice(asAdmin(d), made.id, { reason: 'Erreur' });

    const refused = await refusal(() => mail(d, made.id));

    expect(refused?.status).toBe(400);
  });
});

describe('a credit note asked twice, after the review (P2-07)', () => {
  const credit = (d: Desk, invoiceId: number, dto: Record<string, unknown>) => d.world.svc.invoices.createCreditNote(asAdmin(d), invoiceId, dto as any);

  it('is made once: the second click finds the first, answers with a conflict, and takes no number', async () => {
    const d = desk({ amount: 100, taxRate: 20 });
    const made = await issue(d);

    await credit(d, made.id, { reason: 'Remise', amountTTC: 20 });

    const again = await refusal(() => credit(d, made.id, { reason: 'Remise', amountTTC: 20 }));

    expect(again?.status).toBe(409);
    expect(again?.message).toContain(`AV-${YEAR}-0001`);
    expect(creditNotesOf(d)).toHaveLength(1);
    expect(rows(d, 'documentCounter').find((row) => row.series === 'CREDIT_NOTE')!.last).toBe(1);
    expect(num(invoicesOf(d)[0].creditedAmount)).toBe(20);
  });

  it('is made when the amount or the reason is not the same: those are other credit notes', async () => {
    const d = desk({ amount: 100, taxRate: 20 });
    const made = await issue(d);

    await credit(d, made.id, { reason: 'Remise', amountTTC: 20 });

    expect(await refusal(() => credit(d, made.id, { reason: 'Remise', amountTTC: 21 }))).toBeNull();
    expect(await refusal(() => credit(d, made.id, { reason: 'Geste', amountTTC: 20 }))).toBeNull();
    expect(creditNotesOf(d)).toHaveLength(3);
    expect(audit(d.world).ok).toBe(true);
  });

  it('is made again after a minute: the same remise can be given twice on purpose', async () => {
    const d = desk({ amount: 100, taxRate: 20 });
    const made = await issue(d);

    await credit(d, made.id, { reason: 'Remise', amountTTC: 20 });
    creditNotesOf(d)[0].issuedAt = new Date(Date.now() - 2 * 60_000);

    expect(await refusal(() => credit(d, made.id, { reason: 'Remise', amountTTC: 20 }))).toBeNull();
    expect(creditNotesOf(d).map((row) => row.creditNoteNumber)).toEqual([`AV-${YEAR}-0001`, `AV-${YEAR}-0002`]);
  });

  it('two requests at the same moment, the same remise: one credit note, one conflict', async () => {
    const d = desk({ amount: 100, taxRate: 20 });
    const made = await issue(d);
    const results = await Promise.all([
      refusal(() => credit(d, made.id, { reason: 'Remise', amountTTC: 20 })),
      refusal(() => credit(d, made.id, { reason: 'Remise', amountTTC: 20 })),
    ]);

    expect(results.filter((result) => result === null)).toHaveLength(1);
    expect(results.filter((result) => result?.status === 409)).toHaveLength(1);
    expect(creditNotesOf(d)).toHaveLength(1);
    expect(audit(d.world).ok).toBe(true);
  });
});

describe('a payment recorded by the back office, after the review (P2-07)', () => {
  const record = (d: Desk, invoiceId: number | undefined, amount = 10) =>
    d.world.svc.payments.createAdminManualPayment(d.admin.id, d.job.id, { method: 'BANK_TRANSFER', amount, ...(invoiceId === undefined ? {} : { invoiceId }) } as any);

  it('is refused for an invoice that was cancelled or is still a draft, and is recorded for the invoice that is out', async () => {
    const d = desk({ amount: 100, taxRate: 20 });
    const first = await issue(d);

    await d.world.svc.invoices.cancelInvoice(asAdmin(d), first.id, { reason: 'Erreur' });

    const second = await issue(d);
    const toCancelled = await refusal(() => record(d, first.id));

    expect(toCancelled?.status).toBe(400);
    expect(rows(d, 'payment')).toHaveLength(0);

    invoicesOf(d).find((row) => row.id === second.id)!.status = 'DRAFT';

    const toDraft = await refusal(() => record(d, second.id));

    expect(toDraft?.status).toBe(400);
    expect(rows(d, 'payment')).toHaveLength(0);

    invoicesOf(d).find((row) => row.id === second.id)!.status = 'ISSUED';

    expect(await refusal(() => record(d, second.id))).toBeNull();
    expect(rows(d, 'payment')).toHaveLength(1);
    expect(rows(d, 'payment')[0].invoiceId).toBe(second.id);
  });

  it('is still recorded with no invoice named', async () => {
    const d = desk({ amount: 100, taxRate: 20 });

    await issue(d);

    expect(await refusal(() => record(d, undefined))).toBeNull();
    expect(rows(d, 'payment')).toHaveLength(1);
  });
});

describe('the file of an invoice that the back office uploaded, after the review (P2-07)', () => {
  const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
  const upload = { fieldname: 'file', originalname: 'facture.pdf', mimetype: 'application/pdf', size: PDF.length, buffer: PDF };

  it('is read by the customer and the back office, not by the artisan of the job (it carries the customer\'s details)', async () => {
    const d = desk();
    const made = await issue(d);
    const file: any = await d.world.svc.files.uploadInvoicePdf(asAdmin(d) as any, made.id, upload as any);
    const files = d.world.svc.files;

    for (const read of [
      (who: any) => files.findOne(who, file.id),
      (who: any) => files.getDownloadInfo(who, file.id),
      (who: any) => files.findByEntity(who, 'INVOICE', made.id),
    ]) {
      expect((await refusal(() => read(asArtisan(d))))?.status).toBe(403);
      expect(await refusal(() => read(asClient(d)))).toBeNull();
      expect(await refusal(() => read(asAdmin(d)))).toBeNull();
      expect((await refusal(() => read(asStranger(d))))?.status).toBe(403);
    }
  });

  it('is not the customer\'s while the invoice is a draft', async () => {
    const d = desk();
    const made = await issue(d);
    const file: any = await d.world.svc.files.uploadInvoicePdf(asAdmin(d) as any, made.id, upload as any);

    invoicesOf(d)[0].status = 'DRAFT';

    expect((await refusal(() => d.world.svc.files.findOne(asClient(d) as any, file.id)))?.status).toBe(404);
    expect(await refusal(() => d.world.svc.files.findOne(asAdmin(d) as any, file.id))).toBeNull();
  });
});

describe('what the files say about invoices, after the review (P2-07)', () => {
  // Without the comments: a text that only a comment holds is not in the code.
  const read = (file: string) => stripComments(fs.readFileSync(path.join(__dirname, '../../..', file), 'utf8'));
  const blockOf = (schema: string, model: string) => new RegExp(`model ${model} \\{[\\s\\S]*?\\n\\}`).exec(schema)![0];

  it('deleting a job does not delete its invoices, nor deleting an invoice its credit notes: they hold numbers of a series without gaps', () => {
    const schema = read('prisma/schema.prisma');

    expect(blockOf(schema, 'Invoice')).toMatch(/intervention\s+Intervention\s+@relation\(fields: \[interventionId\], references: \[id\], onDelete: Restrict\)/);
    expect(blockOf(schema, 'CreditNote')).toMatch(/invoice\s+Invoice\s+@relation\(fields: \[invoiceId\], references: \[id\], onDelete: Restrict\)/);
  });

  it('the route that generates an invoice takes a class for its body, so that its checks run (an intersection type has no checks)', () => {
    const controller = read('src/modules/invoices/invoices.controller.ts');
    const dto = read('src/modules/invoices/dto/create-invoice.dto.ts');

    expect(controller).toMatch(/@Post\('generate'\)\s+generateInvoice\(\s+@CurrentUser\(\) user: AuthenticatedUser,\s+@Body\(\) dto: GenerateInvoiceDto,/);
    expect(dto).toMatch(/export class GenerateInvoiceDto extends CreateInvoiceDto \{\s+@IsInt\(\)\s+@Min\(1\)\s+interventionId!: number;/);
  });

  it('the audit reads the invoices, the credit notes and the counters in one snapshot, so that a document made meanwhile is not a false alarm', () => {
    const script = read('scripts/invoice-numbers.ts');

    expect(script).toContain('prisma.$transaction(');
    expect(script).toContain("isolationLevel: 'RepeatableRead'");
    expect(script).not.toContain('Promise.all');
  });
});
