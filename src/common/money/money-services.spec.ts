import { Decimal } from '../testing/decimal-double';
import { World, emptyWorld } from '../testing/world';
import { zonedInstant } from '../availability/weekly-schedule';
import { applyLocale, getLocale, resetLocale } from '../locale/locale';
import { decimalsToNumbers } from './money-numbers';
import { LocaleService } from '../locale/locale.service';
import { RealtimeGateway } from '../../modules/realtime/realtime.gateway';

/**
 * The money of the real services, on a database that answers DECIMAL columns as Decimal objects (P2-01).
 *
 * A service that adds, compares or prints an amount it read from a column without going through `money()` fails here:
 * `a + b` joins two texts, `a > b` compares two texts, and a template string writes "12.345" without the currency.
 */
function shop() {
  const world = emptyWorld();
  const admin = world.memory.plant('user', { role: 'ADMIN', name: 'Admin' });
  const client = world.memory.plant('user', { role: 'CLIENT', name: 'Client' });
  const artisan = world.memory.plant('user', { role: 'ARTISAN', name: 'Artisan' });
  const job = world.memory.plant('intervention', { clientId: client.id, artisanId: artisan.id, status: 'ASSIGNED', serviceType: 'PLOMBIER' });

  return { world, admin, client, artisan, job };
}

const rowsOf = (world: World, model: string) => world.memory.rows(model);
const text = (value: unknown) => String(value);

/** Runs `work` while `new Date()` answers `iso`: the dashboard and the windows read the clock. */
async function atInstant<T>(iso: string, work: () => Promise<T>): Promise<T> {
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

describe('a quote of 12.345 TND is stored and printed exactly (P2-01)', () => {
  beforeEach(() => resetLocale());

  it('stores the amounts exactly, as DECIMAL, and tells the person in dinars', async () => {
    const { world, admin, job } = shop();
    const sent = await world.svc.quotes.createForIntervention(job.id, admin.id, {
      title: 'Fuite',
      taxRate: 0,
      items: [{ label: 'Réparation', quantity: 1, unitPrice: 12.345 }],
    });
    const stored = rowsOf(world, 'quote')[0];

    expect(stored.amountHT instanceof Decimal).toBe(true);
    expect(text(stored.amountHT)).toBe('12.345');
    expect(text(stored.taxAmount)).toBe('0');
    expect(text(stored.amountTTC)).toBe('12.345');
    expect(stored.currency).toBe('TND');
    expect(text(rowsOf(world, 'quoteItem')[0].unitPrice)).toBe('12.345');
    expect(text(rowsOf(world, 'quoteItem')[0].total)).toBe('12.345');

    const event = rowsOf(world, 'interventionEvent').find((row) => row.type === 'QUOTE_SENT');

    expect(event?.message).toBe('Un devis de 12,345 TND TTC a été envoyé au client.');
    expect((event?.metadata as any).amountTTC).toBe(12.345);
    expect(JSON.stringify(event?.metadata)).toContain('"amountTTC":12.345');

    // What the route answers: numbers, with the three decimals.
    expect(JSON.stringify(decimalsToNumbers(sent))).toContain('"amountTTC":12.345');
  });

  it('the tax is rounded once and the total is exactly the two added', async () => {
    const { world, admin, job } = shop();

    await world.svc.quotes.createForIntervention(job.id, admin.id, {
      title: 'Fuite',
      items: [{ label: 'Réparation', quantity: 1, unitPrice: 12.345 }],
    });

    const stored = rowsOf(world, 'quote')[0];

    expect(text(stored.taxRate)).toBe('19');
    expect(text(stored.taxAmount)).toBe('2.346');
    expect(text(stored.amountTTC)).toBe('14.691');
  });

  it('three lines of 0.1 are 0.3, not 0.30000000000000004', async () => {
    const { world, admin, job } = shop();

    await world.svc.quotes.createForIntervention(job.id, admin.id, {
      title: 'Petit',
      taxRate: 0,
      items: [
        { label: 'a', quantity: 1, unitPrice: 0.1 },
        { label: 'b', quantity: 1, unitPrice: 0.1 },
        { label: 'c', quantity: 1, unitPrice: 0.1 },
      ],
    });

    expect(text(rowsOf(world, 'quote')[0].amountHT)).toBe('0.3');
  });

  it('a new rate on a quote without new lines changes the tax and the total with it', async () => {
    const { world, admin, job } = shop();

    await world.svc.quotes.createDraftForIntervention(job.id, admin.id, { title: 'Brouillon', taxRate: 0, items: [{ label: 'a', quantity: 1, unitPrice: 100 }] });

    const id = rowsOf(world, 'quote')[0].id;

    await world.svc.quotes.updateQuote(id, admin.id, { taxRate: 13 });

    const stored = rowsOf(world, 'quote')[0];

    expect(text(stored.taxRate)).toBe('13');
    expect(text(stored.taxAmount)).toBe('13');
    expect(text(stored.amountTTC)).toBe('113');
  });

  it('the back office quote (admin) is priced the same way and says the amount in dinars', async () => {
    const { world, admin, job } = shop();

    await world.svc.admin.sendQuote(admin.id, job.id, { title: 'Devis', taxRate: 7, items: [{ label: 'Pièce', quantity: 3, unitPrice: 12.345 }] });

    const stored = rowsOf(world, 'quote')[0];

    expect(text(stored.amountHT)).toBe('37.035');
    expect(text(stored.taxAmount)).toBe('2.592');
    expect(text(stored.amountTTC)).toBe('39.627');
    expect(rowsOf(world, 'interventionEvent').some((row) => row.message === 'Devis envoyé par l’administration: 39,627 TND TTC.')).toBe(true);
  });

  it('prints in the currency of the company settings', async () => {
    const { world, admin, job } = shop();

    applyLocale({ currency: 'EUR' });
    await world.svc.quotes.createForIntervention(job.id, admin.id, { title: 'Devis', taxRate: 0, items: [{ label: 'a', quantity: 1, unitPrice: 5 }] });

    expect(rowsOf(world, 'quote')[0].currency).toBe('EUR');
    expect(rowsOf(world, 'interventionEvent').find((row) => row.type === 'QUOTE_SENT')?.message).toBe('Un devis de 5,000 EUR TTC a été envoyé au client.');
  });
});

describe('payments, refunds and invoices add up to the millime (P2-01)', () => {
  beforeEach(() => resetLocale());

  it('refunds 0.1 and then 0.2 of a payment of 0.3: the total is exactly the payment', async () => {
    const { world, admin, job } = shop();

    await world.svc.payments.createAdminManualPayment(admin.id, job.id, { method: 'CASH', amount: 0.3 });

    const id = rowsOf(world, 'payment')[0].id;

    rowsOf(world, 'payment')[0].status = 'PAID';
    await world.svc.payments.refund(id, admin.id, { amount: 0.1 });
    expect(rowsOf(world, 'payment')[0].status).toBe('PARTIALLY_REFUNDED');

    await world.svc.payments.refund(id, admin.id, { amount: 0.2 });

    const stored = rowsOf(world, 'payment')[0];

    expect(text(stored.amountRefunded)).toBe('0.3');
    expect(stored.status).toBe('REFUNDED');
    expect(stored.currency).toBe('TND');
  });

  it('refuses a refund of more than the payment, to the millime', async () => {
    const { world, admin, job } = shop();

    await world.svc.payments.createAdminManualPayment(admin.id, job.id, { method: 'CASH', amount: 12.345 });
    rowsOf(world, 'payment')[0].status = 'PAID';

    const id = rowsOf(world, 'payment')[0].id;

    await world.svc.payments.refund(id, admin.id, { amount: 12.344 });

    let refused = '';

    try {
      await world.svc.payments.refund(id, admin.id, { amount: 0.002 });
    } catch (error) {
      refused = (error as Error).message;
    }

    expect(refused).toBe('Le montant total remboursé ne peut pas dépasser le montant du paiement.');
    expect(text(rowsOf(world, 'payment')[0].amountRefunded)).toBe('12.344');
  });

  it('the currency of a payment is the one of what is paid, never one typed by the payer', async () => {
    const { world, admin, job } = shop();

    await world.svc.payments.createAdminManualPayment(admin.id, job.id, { method: 'CASH', amount: 5, currency: 'USD' });

    expect(rowsOf(world, 'payment')[0].currency).toBe('TND');
  });

  it('an invoice made from an amount keeps the three decimals, the currency and the matricule fiscal', async () => {
    const { world, admin, job } = shop();

    world.memory.plant('companySettings', { companyName: 'Smart Dépannage', matriculeFiscal: '1234567A/M/000' });

    await world.svc.invoices.createForIntervention(job.id, admin.id, { amountHT: 12.345, taxRate: 19 });

    const stored = rowsOf(world, 'invoice')[0];

    expect(text(stored.amountHT)).toBe('12.345');
    expect(text(stored.taxAmount)).toBe('2.346');
    expect(text(stored.amountTTC)).toBe('14.691');
    expect(stored.currency).toBe('TND');
    expect(stored.companyTaxId).toBe('1234567A/M/000');
    expect(text(rowsOf(world, 'invoiceItem')[0].total)).toBe('12.345');
    // The number comes from the counter of the year, in order (P2-07).
    expect(/^F-\d{4}-0001$/.test(stored.invoiceNumber)).toBe(true);
    expect(stored.sequence).toBe(1);
  });
});

describe('a document keeps the currency and the amounts it was written with (P2-01)', () => {
  beforeEach(() => resetLocale());

  const acceptedQuote = (world: World, jobId: number, fields: Record<string, unknown> = {}) =>
    world.memory.plant('quote', { interventionId: jobId, status: 'ACCEPTED', title: 'Fuite', currency: 'EUR', amountHT: 10.01, taxRate: 19, taxAmount: 1.9, amountTTC: 11.91, ...fields });

  it('an invoice made from the accepted quote is that quote: its currency and its amounts to the millime', async () => {
    const { world, admin, job } = shop();

    // A quote from before the millime columns: the tax was rounded to the cent (19 % of 10.01 is 1.9019).
    acceptedQuote(world, job.id);

    await world.svc.invoices.createForIntervention(job.id, admin.id, {} as any);

    const invoice = rowsOf(world, 'invoice')[0];

    expect(invoice.currency).toBe('EUR');
    expect(text(invoice.amountHT)).toBe('10.01');
    expect(text(invoice.taxAmount)).toBe('1.9');
    expect(text(invoice.amountTTC)).toBe('11.91');
    expect(text(invoice.taxRate)).toBe('19');
  });

  it('an amount or a rate sent by the administrator is worked out again, still in the currency of the quote', async () => {
    const { world, admin, job } = shop();

    acceptedQuote(world, job.id);

    await world.svc.invoices.createForIntervention(job.id, admin.id, { amountHT: 10.01 } as any);

    const invoice = rowsOf(world, 'invoice')[0];

    expect(invoice.currency).toBe('EUR');
    expect(text(invoice.taxAmount)).toBe('1.902');
    expect(text(invoice.amountTTC)).toBe('11.912');
  });

  it('a payment takes the currency of the invoice it pays, then of the accepted quote, then of the company', async () => {
    const quoted = shop();

    acceptedQuote(quoted.world, quoted.job.id, { currency: 'USD' });
    await quoted.world.svc.payments.createAdminManualPayment(quoted.admin.id, quoted.job.id, { method: 'CASH' } as any);

    expect(rowsOf(quoted.world, 'payment')[0].currency).toBe('USD');

    const invoiced = shop();

    applyLocale({ currency: 'GBP' });
    await invoiced.world.svc.invoices.createForIntervention(invoiced.job.id, invoiced.admin.id, { amountHT: 10, taxRate: 0 } as any);
    applyLocale({ currency: 'TND' });
    acceptedQuote(invoiced.world, invoiced.job.id, { currency: 'USD' });
    await invoiced.world.svc.payments.createAdminManualPayment(invoiced.admin.id, invoiced.job.id, { method: 'CASH', currency: 'JPY', invoiceId: rowsOf(invoiced.world, 'invoice')[0].id } as any);

    expect(rowsOf(invoiced.world, 'payment')[0].currency).toBe('GBP');

    const alone = shop();

    applyLocale({ currency: 'MAD' });
    await alone.world.svc.payments.createAdminManualPayment(alone.admin.id, alone.job.id, { method: 'CASH', amount: 5, currency: 'JPY' } as any);

    expect(rowsOf(alone.world, 'payment')[0].currency).toBe('MAD');
  });
});

describe('the invoices leave in dinars with three decimals (P2-01)', () => {
  beforeEach(() => resetLocale());

  it('the export of the invoices writes the amounts as text with three decimals', async () => {
    const { world, admin, job } = shop();

    await world.svc.invoices.createForIntervention(job.id, admin.id, { amountHT: 12.3, taxRate: 0 });

    const exported: any = await world.svc.invoices.exportInvoices({ id: admin.id, userId: admin.id, role: 'ADMIN' } as any, { format: 'csv' } as any);

    expect(exported.format).toBe('csv');
    expect(exported.content).toContain(',12.300,0,0.000,12.300,TND,');
  });

  it('the JSON export keeps the same three-decimal texts, so that a file and a screen never disagree', async () => {
    const { world, admin, job } = shop();

    await world.svc.invoices.createForIntervention(job.id, admin.id, { amountHT: 1000.5, taxRate: 19 });

    const exported: any = await world.svc.invoices.exportInvoices({ id: admin.id, userId: admin.id, role: 'ADMIN' } as any, {} as any);

    expect(exported.rows[0].amountHT).toBe('1000.500');
    expect(exported.rows[0].taxAmount).toBe('190.095');
    expect(exported.rows[0].amountTTC).toBe('1190.595');
  });

  it('the e-mail of an invoice says the amount in the currency written on the invoice, not the one of today', async () => {
    const { world, admin, job } = shop();

    applyLocale({ currency: 'EUR' });
    await world.svc.invoices.createForIntervention(job.id, admin.id, { amountHT: 1234.5, taxRate: 0 });
    applyLocale({ currency: 'TND' });

    const invoice = rowsOf(world, 'invoice')[0];
    const sent: string[][] = [];

    invoice.clientEmail = 'client@example.com';
    (world.svc.invoices as any).notifications = {
      isEmailSimulated: () => false,
      sendEmail: async (to: string, subject: string, body: string) => {
        sent.push([to, subject, body]);

        return { queued: true };
      },
    };

    await world.svc.invoices.sendInvoiceByEmail({ id: admin.id, userId: admin.id, role: 'ADMIN' } as any, invoice.id, {} as any);

    expect(sent.length).toBe(1);
    expect(sent[0][2]).toContain('1 234,500 EUR TTC');
    expect(sent[0][2]).not.toContain('TND');
  });
});

describe('the reports of the business are exact (P2-01)', () => {
  beforeEach(() => resetLocale());

  it('the commission is a percent of the price in millimes, and the dashboard adds the rows exactly', async () => {
    const { world, admin, job } = shop();
    const other = world.memory.plant('intervention', { clientId: job.clientId, artisanId: job.artisanId, status: 'COMPLETED', serviceType: 'PLOMBIER' });

    // the figures are worked out from the confirmed payments (P2-03)
    world.memory.plant('payment', { interventionId: job.id, method: 'BANK_TRANSFER', status: 'PAID', amount: 12.345, amountRefunded: 0, currency: 'TND', createdById: job.clientId });
    world.memory.plant('payment', { interventionId: other.id, method: 'BANK_TRANSFER', status: 'PAID', amount: 0.1, amountRefunded: 0, currency: 'TND', createdById: job.clientId });

    await world.svc.business.calculateInterventionFinancials(admin.id, 'ADMIN', job.id, { commissionRate: 20 });
    await world.svc.business.calculateInterventionFinancials(admin.id, 'ADMIN', other.id, { commissionRate: 20 });

    const first = rowsOf(world, 'interventionFinancials')[0];

    expect(text(first.platformCommission)).toBe('2.469');
    expect(text(first.artisanPayout)).toBe('9.876');
    expect(text(first.netRevenue)).toBe('2.469');
    expect(first.currency).toBe('TND');

    const dashboard = await world.svc.business.revenueDashboard(admin.id, 'ADMIN', {});

    expect(dashboard.totals.totalRevenue).toBe(12.445);
    expect(dashboard.totals.totalCommission).toBe(2.489);
    expect(dashboard.totals.totalArtisanPayouts).toBe(9.956);
    expect(dashboard.totals.averageOrderValue).toBe(6.223);
    expect(dashboard.totals.marginRate).toBe(20);
    expect(typeof dashboard.totals.totalRevenue).toBe('number');
  });

  it('the exports are in dinars with three decimals', async () => {
    const { world, admin, job } = shop();

    world.memory.plant('payment', { interventionId: job.id, method: 'BANK_TRANSFER', status: 'PAID', amount: 12.345, amountRefunded: 0, currency: 'TND', createdById: job.clientId });
    await world.svc.business.calculateInterventionFinancials(admin.id, 'ADMIN', job.id, { commissionRate: 20 });

    const csv = (await world.svc.business.exportRevenueCsv(admin.id, 'ADMIN', {})).buffer.toString('utf8');

    expect(csv).toContain(',TND,12.345,9.876,2.469,0.000,0.000,2.469,2.469,');

    const pdf = (await world.svc.business.exportRevenuePdf(admin.id, 'ADMIN', {})).buffer.toString('latin1');

    expect(pdf).toContain('Total revenue: 12,345 TND');
    expect(pdf).not.toContain('EUR');

    const accounting = await world.svc.business.createAccountingExport(admin.id, 'ADMIN', { from: '2020-01-01T00:00:00Z', to: '2099-01-01T00:00:00Z' });

    expect(text(accounting.export.totalDebit)).toBe('12.345');
    expect(text(accounting.export.totalCredit)).toBe('12.345');
    expect(accounting.file.buffer.toString('utf8')).toContain('CLIENT_REVENUE');
    expect(accounting.file.buffer.toString('utf8')).toContain('12.345,0.000');
  });

  it('the dashboard of the back office adds today’s payments exactly', async () => {
    const { world, admin, job } = shop();

    for (const amount of [0.1, 0.2]) world.memory.plant('payment', { interventionId: job.id, amount, status: 'PAID', method: 'CASH' });

    const kpis = await world.svc.admin.getDashboardKpis();

    expect(kpis.monthlyRevenue).toBe(0.3);
    expect(kpis.todayRevenue).toBe(0.3);
    expect(typeof kpis.todayRevenue).toBe('number');
  });

  it('today and this month begin at midnight in Tunis: a payment at 00:10 Tunis is today’s, one at 23:50 the evening before is not', async () => {
    const before = process.env.TZ;

    try {
      for (const zone of ['UTC', 'Africa/Tunis', 'America/Los_Angeles', 'Pacific/Auckland']) {
        process.env.TZ = zone;

        const { world, admin, job } = shop();
        const pay = (iso: string, amount: number) => world.memory.plant('payment', { interventionId: job.id, amount, status: 'PAID', method: 'CASH', createdAt: new Date(iso) });

        // Friday 23 October 2026, 23:30 UTC, is Saturday 24 October, 00:30 in Tunis.
        pay('2026-10-23T23:10:00.000Z', 1); //       00:10 on the 24th in Tunis: today
        pay('2026-10-23T22:50:00.000Z', 10); //      23:50 on the 23rd: this month, not today
        pay('2026-09-30T23:30:00.000Z', 100); //     00:30 on the 1st of October: this month
        pay('2026-09-30T22:30:00.000Z', 1000); //    23:30 on the 30th of September: last month

        const kpis: any = await atInstant('2026-10-23T23:30:00.000Z', () => world.svc.admin.getDashboardKpis());

        expect(kpis.todayRevenue).toBe(1);
        expect(kpis.monthlyRevenue).toBe(111);
        void admin;
      }
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });
});

describe('the company settings carry the locale (P2-01)', () => {
  beforeEach(() => resetLocale());

  it('the first settings are Tunisian: dinar, the clock of Tunis, 19 % and the Tunisian rates', async () => {
    const { world } = shop();
    const settings = await world.svc.admin.getCompanySettings();

    expect(settings.currency).toBe('TND');
    expect(settings.timezone).toBe('Africa/Tunis');
    expect(text(settings.defaultTaxRate)).toBe('19');
    expect(settings.taxRates.map((rate: any) => rate.rate)).toEqual([19, 13, 7, 0]);
  });

  it('a row saved before the list of rates existed (20 %, no list) is valid: it loads, shows its list, and still saves its other fields', async () => {
    for (const rate of [20, 18, 5.5, 19]) {
      resetLocale();

      const { world } = shop();

      world.memory.plant('companySettings', { companyName: 'Smart Dépannage', currency: 'TND', timezone: 'Africa/Tunis', defaultTaxRate: rate });

      expect(await new LocaleService(world.prisma).refresh()).toBe(true);
      expect(getLocale().defaultTaxRate).toBe(rate);
      expect(getLocale().taxRates.some((entry) => entry.rate === rate)).toBe(true);
      expect([19, 13, 7, 0].every((code) => getLocale().taxRates.some((entry) => entry.rate === code))).toBe(true);

      const shown = await world.svc.admin.getCompanySettings();

      expect(shown.taxRates.some((entry: any) => entry.rate === rate)).toBe(true);

      const saved = await world.svc.admin.updateCompanySettings({ companyPhone: '+21671000000' });

      expect(saved.companyPhone).toBe('+21671000000');
      expect(getLocale().defaultTaxRate).toBe(rate);
    }
  });

  it('a stored zone and currency are read even when the rate is an old one', async () => {
    const { world } = shop();

    world.memory.plant('companySettings', { currency: 'EUR', timezone: 'Europe/Paris', defaultTaxRate: 20 });

    expect(await new LocaleService(world.prisma).refresh()).toBe(true);
    expect(getLocale().currency).toBe('EUR');
    expect(getLocale().timeZone).toBe('Europe/Paris');
  });

  it('null clears the RIB and the matricule fiscal, like an empty text', async () => {
    const { world } = shop();

    await world.svc.admin.updateCompanySettings({ rib: '08 006 0123456789123 45', matriculeFiscal: '1234567A/M/000' });

    const cleared = await world.svc.admin.updateCompanySettings({ rib: null, matriculeFiscal: null } as any);

    expect(cleared.rib).toBeNull();
    expect(cleared.matriculeFiscal).toBeNull();
  });

  it('saving them changes what the server reads, and a refused value changes nothing', async () => {
    const { world } = shop();

    await world.svc.admin.getCompanySettings();

    const saved = await world.svc.admin.updateCompanySettings({
      currency: 'EUR',
      timezone: 'Europe/Paris',
      taxRates: [{ code: 'STANDARD', label: 'TVA 20 %', rate: 20 }],
      defaultTaxRate: 20,
      rib: '08 006 0123456789012 34',
      matriculeFiscal: '1234567a/m/000',
    });

    expect(saved.currency).toBe('EUR');
    expect(saved.rib).toBe('08006012345678901234');
    expect(saved.matriculeFiscal).toBe('1234567A/M/000');
    expect(text(saved.defaultTaxRate)).toBe('20');

    expect(getLocale().currency).toBe('EUR');
    expect(getLocale().timeZone).toBe('Europe/Paris');

    for (const bad of [{ currency: 'euro' }, { timezone: 'Mars/Base' }, { defaultTaxRate: 19 }, { rib: '123' }, { matriculeFiscal: 'abc' }, { taxRates: [] }]) {
      let message = '';

      try {
        await world.svc.admin.updateCompanySettings(bad);
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message === '').toBe(false);
      expect(getLocale().currency).toBe('EUR');
      expect(rowsOf(world, 'companySettings')[0].currency).toBe('EUR');
    }

    const cleared = await world.svc.admin.updateCompanySettings({ rib: '', matriculeFiscal: ' ' });

    expect(cleared.rib).toBeNull();
    expect(cleared.matriculeFiscal).toBeNull();
  });
});

describe('an appointment at 09:00 Tunis time matches availability set at 09:00 Tunis time (P2-01)', () => {
  beforeEach(() => resetLocale());

  const MONDAY = '2026-10-26';

  /** The database as the double-booking check reads it: nothing booked, and an artisan who works on Mondays from 09:00 to 10:00. */
  const mondayNineToTen = (artisanId: number) => ({
    appointment: { findMany: async () => [] },
    artisanTimeBlock: { findMany: async () => [] },
    artisanProfile: {
      findUnique: async () => ({ userId: artisanId, availability: [{ dayOfWeek: 'MONDAY', startTime: '09:00', endTime: '10:00', isAvailable: true }] }),
    },
  });

  it('the day of an artisan is midnight to midnight in Tunis, whatever the clock of the server says', async () => {
    const before = process.env.TZ;

    try {
      for (const zone of ['UTC', 'Africa/Tunis', 'America/Los_Angeles', 'Pacific/Auckland']) {
        process.env.TZ = zone;

        const { world, admin, artisan, client, job } = shop();
        const nine = zonedInstant(MONDAY, '09:00', 'Africa/Tunis')!;
        const midnightPlus = zonedInstant(MONDAY, '00:30', 'Africa/Tunis')!;

        for (const startsAt of [nine, midnightPlus]) {
          world.memory.plant('appointment', {
            interventionId: world.memory.plant('intervention', { clientId: client.id, artisanId: artisan.id, status: 'ASSIGNED', serviceType: 'PLOMBIER' }).id,
            clientId: client.id,
            artisanId: artisan.id,
            status: 'CONFIRMED',
            startsAt,
            endsAt: new Date(startsAt.getTime() + 3_600_000),
          });
        }

        void job;

        const monday = await world.svc.scheduling.getArtisanDailySchedule(admin.id, 'ADMIN', MONDAY, artisan.id);
        const sunday = await world.svc.scheduling.getArtisanDailySchedule(admin.id, 'ADMIN', '2026-10-25', artisan.id);
        const tuesday = await world.svc.scheduling.getArtisanDailySchedule(admin.id, 'ADMIN', '2026-10-27', artisan.id);

        expect(monday.length).toBe(2);
        expect(sunday.length).toBe(0);
        expect(tuesday.length).toBe(0);
      }
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });

  it('the calendar of an artisan for a day is that day in Tunis: a visit at 00:30 on Monday is Monday’s, not Sunday’s', async () => {
    const before = process.env.TZ;

    try {
      for (const zone of ['UTC', 'Africa/Tunis', 'America/Los_Angeles', 'Pacific/Auckland']) {
        process.env.TZ = zone;

        const { world, admin, artisan, client } = shop();
        const startsAt = zonedInstant(MONDAY, '00:30', 'Africa/Tunis')!;
        const other = world.memory.plant('intervention', { clientId: client.id, artisanId: artisan.id, status: 'ASSIGNED', serviceType: 'PLOMBIER' });

        world.memory.plant('appointment', { interventionId: other.id, clientId: client.id, artisanId: artisan.id, status: 'CONFIRMED', startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000) });

        const monday = await world.svc.scheduling.getArtisanAvailability(admin.id, 'ADMIN', artisan.id, MONDAY);
        const sunday = await world.svc.scheduling.getArtisanAvailability(admin.id, 'ADMIN', artisan.id, '2026-10-25');

        expect(monday.appointments.length).toBe(1);
        expect(sunday.appointments.length).toBe(0);
      }
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });

  it('availability set at 09:00 Tunis time takes a visit at 09:00 Tunis time, and not one at 09:00 UTC, on any clock of the server', async () => {
    const before = process.env.TZ;

    try {
      for (const zone of ['UTC', 'Africa/Tunis', 'America/Los_Angeles', 'Pacific/Auckland']) {
        process.env.TZ = zone;

        const { world, artisan } = shop();

        const book = (startsAt: Date, endsAt: Date) => (world.svc.scheduling as any).checkDoubleBooking({ artisanId: artisan.id, startsAt, endsAt, db: mondayNineToTen(artisan.id) });
        const tunis = await book(zonedInstant(MONDAY, '09:00', 'Africa/Tunis')!, zonedInstant(MONDAY, '10:00', 'Africa/Tunis')!);
        const utc = await book(new Date(`${MONDAY}T09:00:00.000Z`), new Date(`${MONDAY}T10:00:00.000Z`));

        expect(tunis.withinAvailability).toBe(true);
        expect(tunis.available).toBe(true);
        expect(utc.withinAvailability).toBe(false);
      }
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });

  it('and the clock is the one of the company settings once they are read: 09:00 in Dubai is 05:00 UTC', async () => {
    const { world, artisan } = shop();

    const book = () => (world.svc.scheduling as any).checkDoubleBooking({ artisanId: artisan.id, startsAt: new Date(`${MONDAY}T05:00:00.000Z`), endsAt: new Date(`${MONDAY}T06:00:00.000Z`), db: mondayNineToTen(artisan.id) });

    expect((await book()).withinAvailability).toBe(false);

    applyLocale({ timezone: 'Asia/Dubai' });

    expect((await book()).withinAvailability).toBe(true);
  });

  it('a time written without an offset is read on the clock of the business, not on the one of the server', async () => {
    const before = process.env.TZ;

    try {
      for (const zone of ['UTC', 'Africa/Tunis', 'America/Los_Angeles', 'Pacific/Auckland']) {
        process.env.TZ = zone;

        const { world, artisan } = shop();

        // 00:10 to 00:40 on Monday in Tunis is Sunday 23:10 to 23:40 UTC.
        world.memory.plant('artisanTimeBlock', { artisanId: artisan.id, startsAt: new Date('2026-10-25T23:10:00.000Z'), endsAt: new Date('2026-10-25T23:40:00.000Z') });

        const monday = await world.svc.scheduling.listMyTimeBlocks(artisan.id, 'ARTISAN', '2026-10-26T00:00:00', '2026-10-27T00:00:00');
        const sunday = await world.svc.scheduling.listMyTimeBlocks(artisan.id, 'ARTISAN', '2026-10-25T00:00:00', '2026-10-26T00:00:00');

        expect(monday.length).toBe(1);
        expect(sunday.length).toBe(0);
      }
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });

  it('a block of time and a request to move a visit, written without an offset, are stored on the clock of the business', async () => {
    const before = process.env.TZ;

    try {
      for (const zone of ['UTC', 'America/Los_Angeles', 'Pacific/Auckland']) {
        process.env.TZ = zone;

        const { world, artisan, client, job } = shop();

        await world.svc.scheduling.createTimeBlock(artisan.id, 'ARTISAN', { startsAt: '2026-10-26T09:00:00', endsAt: '2026-10-26T10:00:00' } as any);

        const block = rowsOf(world, 'artisanTimeBlock')[0];

        expect(block.startsAt.toISOString()).toBe('2026-10-26T08:00:00.000Z');
        expect(block.endsAt.toISOString()).toBe('2026-10-26T09:00:00.000Z');

        const visit = world.memory.plant('appointment', {
          interventionId: job.id,
          clientId: client.id,
          artisanId: artisan.id,
          status: 'CONFIRMED',
          startsAt: new Date('2026-10-27T07:00:00.000Z'),
          endsAt: new Date('2026-10-27T08:00:00.000Z'),
        });

        await world.svc.scheduling.requestReschedule(client.id, 'CLIENT', visit.id, { requestedStartAt: '2026-10-28T09:00:00', requestedEndAt: '2026-10-28T10:00:00', reason: 'Imprévu' } as any);

        const asked = rowsOf(world, 'appointmentRequest')[0];

        expect(asked.requestedStartAt.toISOString()).toBe('2026-10-28T08:00:00.000Z');
        expect(asked.requestedEndAt.toISOString()).toBe('2026-10-28T09:00:00.000Z');
      }
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });

  it('a date that is not a date is refused', async () => {
    const { world, admin, artisan } = shop();
    let message = '';

    try {
      await world.svc.scheduling.getArtisanDailySchedule(admin.id, 'ADMIN', 'not-a-date', artisan.id);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toBe('Date invalide.');
  });
});

describe('the appointment is written on the clock of the business (P2-01)', () => {
  beforeEach(() => resetLocale());

  it('a new request for a time stores the time zone of the business, not Paris', async () => {
    const { world, client, job } = shop();

    await world.svc.scheduling.choosePreferredTime(client.id, 'CLIENT', job.id, { preferredDate: '2026-10-26', preferredStartTime: '09:00', preferredEndTime: '11:00' });

    expect(rowsOf(world, 'appointment')[0].timezone).toBe('Africa/Tunis');
  });

  it('and the one of the company settings once they are read', async () => {
    const { world, client, job } = shop();

    applyLocale({ timezone: 'Africa/Casablanca' });
    await world.svc.scheduling.choosePreferredTime(client.id, 'CLIENT', job.id, { preferredDate: '2026-10-26', preferredStartTime: '09:00', preferredEndTime: '11:00' });

    expect(rowsOf(world, 'appointment')[0].timezone).toBe('Africa/Casablanca');
  });
});

describe('the locale is read from the company settings (P2-01)', () => {
  beforeEach(() => resetLocale());

  it('the server reads the row when it starts, and the rates with it', async () => {
    const { world } = shop();

    world.memory.plant('companySettings', { currency: 'EUR', timezone: 'Europe/Paris', defaultTaxRate: 20, taxRates: [{ code: 'STANDARD', label: 'TVA 20 %', rate: 20 }] });

    const service = new LocaleService(world.prisma);

    expect(await service.refresh()).toBe(true);
    expect(getLocale().currency).toBe('EUR');
    expect(getLocale().timeZone).toBe('Europe/Paris');
    expect(getLocale().defaultTaxRate).toBe(20);
    expect(getLocale().taxRates.map((rate) => rate.rate)).toEqual([20]);
  });

  it('a row with no list of rates takes the rates of the country, not the list that was read before', async () => {
    const { world } = shop();

    applyLocale({ taxRates: [{ code: 'ONLY', label: '20 %', rate: 20 }], defaultTaxRate: 20 });
    world.memory.plant('companySettings', { currency: 'TND', timezone: 'Africa/Tunis', defaultTaxRate: 13 });

    expect(await new LocaleService(world.prisma).refresh()).toBe(true);
    expect(getLocale().defaultTaxRate).toBe(13);
    expect(getLocale().taxRates.map((rate) => rate.rate)).toEqual([19, 13, 7, 0]);
  });

  it('no row, or a row that cannot be read, leaves the locale as it was and never stops the server', async () => {
    const { world } = shop();
    const service = new LocaleService(world.prisma);

    expect(await service.refresh()).toBe(false);
    expect(getLocale().currency).toBe('TND');

    world.memory.plant('companySettings', { currency: 'EUR', timezone: 'Mars/Base', defaultTaxRate: 19 });

    expect(await service.refresh()).toBe(false);
    expect(getLocale().currency).toBe('TND');
  });
});

describe('live events carry plain numbers (P2-01)', () => {
  it('every room helper turns a Decimal into a number before it emits', () => {
    const sent: Array<{ event: string; payload: any }> = [];
    const chain: any = {
      to: () => chain,
      emit: (event: string, payload: any) => sent.push({ event, payload }),
    };
    const gateway: any = new RealtimeGateway({} as any, {} as any);

    gateway.server = { to: () => chain };

    const payload = { amount: new Decimal('12.345'), payment: { amountRefunded: new Decimal('0.5') } };

    gateway.emitToAdmins('a', payload);
    gateway.emitToUser(1, 'b', payload);
    gateway.emitToClient(1, 'c', payload);
    gateway.emitToArtisan(1, 'd', payload);
    gateway.emitToIntervention(1, 'e', payload);

    expect(sent.map((entry) => entry.event)).toEqual(['a', 'b', 'c', 'd', 'e']);

    for (const entry of sent) {
      expect(entry.payload.amount).toBe(12.345);
      expect(entry.payload.payment.amountRefunded).toBe(0.5);
      expect(JSON.stringify(entry.payload)).toBe('{"amount":12.345,"payment":{"amountRefunded":0.5}}');
    }
  });
});
