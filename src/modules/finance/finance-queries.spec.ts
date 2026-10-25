import { periodOf } from './finance-period';
import {
  INVOICE_VIEWS,
  PAYMENT_SORTS,
  PAYMENT_VIEWS,
  csvAmount,
  csvCell,
  csvMoment,
  invoiceListRow,
  invoicePeriodApplies,
  invoicesWhere,
  issuedInvoicesWhere,
  likeLiteral,
  paymentListRow,
  paymentPeriodApplies,
  paymentViewOf,
  paymentsCsv,
  paymentsOrder,
  paymentsWhere,
  searchText,
} from './finance-queries';

const NOW = new Date('2026-10-24T20:00:00.000Z');
const NONE = periodOf(undefined, undefined, NOW);
const WEEK = periodOf('2026-10-19', '2026-10-25', NOW);

const clauses = (where: Record<string, any>): any[] => where.AND ?? [];

describe('the filters of the payments list (P2-08)', () => {
  it('knows its tabs, and reads anything else as "all"', () => {
    expect([...PAYMENT_VIEWS]).toEqual(['all', 'awaiting', 'received', 'refunded']);
    expect([...PAYMENT_SORTS]).toEqual(['newest', 'oldest']);
    expect(paymentViewOf('awaiting')).toBe('awaiting');
    expect(paymentViewOf('nope')).toBe('all');
    expect(paymentViewOf(undefined)).toBe('all');
    expect(paymentViewOf(['awaiting'])).toBe('all');
    expect(paymentViewOf(7)).toBe('all');
  });

  it('asks for nothing when nothing is chosen and no period is written', () => {
    expect(paymentsWhere({}, NONE)).toEqual({});
  });

  it('holds the payments that wait for the team in the "awaiting" tab: asked for and not decided', () => {
    expect(clauses(paymentsWhere({ view: 'awaiting' }, NONE))).toEqual([{ OR: [{ status: 'AWAITING_CONFIRMATION' }, { status: 'PENDING', method: { in: ['CASH', 'BANK_TRANSFER'] } }] }]);
  });

  it('holds money that came in, even if it went back since, in the "received" tab', () => {
    expect(clauses(paymentsWhere({ view: 'received' }, NONE))).toEqual([{ status: { in: ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'] } }]);
  });

  it('holds money that went back, in part or in full, in the "refunded" tab', () => {
    expect(clauses(paymentsWhere({ view: 'refunded' }, NONE))).toEqual([{ status: { in: ['PARTIALLY_REFUNDED', 'REFUNDED'] } }]);
  });

  it('puts the period on the date the tab is about: asked for, confirmed, given back', () => {
    const window = { gte: WEEK.start, lt: WEEK.end };

    expect(clauses(paymentsWhere({ view: 'all' }, WEEK))).toEqual([{ requestedAt: window }]);
    // What waits is shown whatever its date: the summary counts it that way.
    expect(clauses(paymentsWhere({ view: 'awaiting' }, WEEK))).toEqual([{ OR: [{ status: 'AWAITING_CONFIRMATION' }, { status: 'PENDING', method: { in: ['CASH', 'BANK_TRANSFER'] } }] }]);
    expect(clauses(paymentsWhere({ view: 'received' }, WEEK)).pop()).toEqual({ confirmedAt: window });
    expect(clauses(paymentsWhere({ view: 'refunded' }, WEEK)).pop()).toEqual({ refundedAt: window });
  });

  it('adds the status and the method the caller chose', () => {
    expect(clauses(paymentsWhere({ view: 'all', status: 'FAILED', method: 'CASH' }, NONE))).toEqual([{ status: 'FAILED' }, { method: 'CASH' }]);
  });

  it('looks a search up by the job number, the payment number, the reference, the receipt, the invoice and the customer', () => {
    const [search] = clauses(paymentsWhere({ search: ' 12 ' }, NONE));

    expect(search.OR).toEqual([
      { interventionId: 12 },
      { id: 12 },
      { reference: { contains: '12', mode: 'insensitive' } },
      { receiptNumber: { contains: '12', mode: 'insensitive' } },
      { invoice: { invoiceNumber: { contains: '12', mode: 'insensitive' } } },
      { intervention: { client: { name: { contains: '12', mode: 'insensitive' } } } },
      { intervention: { client: { phone: { contains: '12' } } } },
    ]);
  });

  it('reads "#12" as a number too, and a name as text only', () => {
    expect(clauses(paymentsWhere({ search: '#12' }, NONE))[0].OR.slice(0, 2)).toEqual([{ interventionId: 12 }, { id: 12 }]);
    expect(clauses(paymentsWhere({ search: 'Ben Salah' }, NONE))[0].OR[0]).toEqual({ reference: { contains: 'Ben Salah', mode: 'insensitive' } });
  });

  it('does not read a number past the largest row id of the database as a row (it would be a database error)', () => {
    expect(clauses(paymentsWhere({ search: '2147483647' }, NONE))[0].OR[0]).toEqual({ interventionId: 2147483647 });
    expect(clauses(paymentsWhere({ search: '2147483648' }, NONE))[0].OR[0]).toEqual({ reference: { contains: '2147483648', mode: 'insensitive' } });
    expect(clauses(paymentsWhere({ search: '0' }, NONE))[0].OR[0]).toEqual({ reference: { contains: '0', mode: 'insensitive' } });
  });

  it('searches nothing for a blank, a non-text and cuts a long text at 100 characters', () => {
    expect(searchText('   ')).toBeNull();
    expect(searchText(undefined)).toBeNull();
    expect(searchText(12)).toBeNull();
    expect(searchText(' abc ')).toBe('abc');
    expect(searchText('x'.repeat(150))).toHaveLength(100);
    expect(paymentsWhere({ search: '  ' }, NONE)).toEqual({});
  });

  it('puts the longest wait first in the "awaiting" tab and the newest first elsewhere, unless the caller says', () => {
    expect(paymentsOrder('awaiting', undefined)).toEqual([{ requestedAt: 'asc' }, { id: 'asc' }]);
    expect(paymentsOrder('awaiting', 'newest')).toEqual([{ requestedAt: 'desc' }, { id: 'desc' }]);
    expect(paymentsOrder('all', undefined)).toEqual([{ requestedAt: 'desc' }, { id: 'desc' }]);
    expect(paymentsOrder('received', undefined)).toEqual([{ confirmedAt: 'desc' }, { id: 'desc' }]);
    expect(paymentsOrder('received', 'oldest')).toEqual([{ confirmedAt: 'asc' }, { id: 'asc' }]);
    expect(paymentsOrder('refunded', 'bogus')).toEqual([{ refundedAt: 'desc' }, { id: 'desc' }]);
  });
});

describe('the rows of the payments list (P2-08)', () => {
  const payment = (extra: Record<string, any> = {}) => ({
    id: 7,
    interventionId: 3,
    method: 'CASH',
    provider: 'CASH',
    status: 'PAID',
    amount: '120.000',
    amountRefunded: '0.000',
    currency: 'TND',
    reference: null,
    receiptNumber: 'R-1',
    adminNote: null,
    failureReason: 'échec',
    cancelReason: 'annulé',
    refundReason: 'remboursé',
    requestedAt: new Date('2026-10-19T08:00:00Z'),
    confirmedAt: new Date('2026-10-19T09:00:00Z'),
    failedAt: null,
    refundedAt: null,
    cancelledAt: null,
    invoice: { id: 2, invoiceNumber: 'F-2026-0002', status: 'ISSUED' },
    intervention: { id: 3, status: 'PAID', serviceType: 'PLOMBIER', client: { id: 4, name: 'Ben Salah', phone: '20111222' }, artisan: { id: 5, name: 'Artisan' } },
    ...extra,
  });

  it('gives plain numbers and the names a screen needs', () => {
    const row = paymentListRow(payment(), null);

    expect(row.amount).toBe(120);
    expect(row.amountRefunded).toBe(0);
    expect(row.refundable).toBe(120);
    expect(row.invoice).toEqual({ id: 2, number: 'F-2026-0002', status: 'ISSUED' });
    expect(row.client).toEqual({ id: 4, name: 'Ben Salah', phone: '20111222' });
    expect(row.artisan).toEqual({ id: 5, name: 'Artisan' });
    expect(row.job).toEqual({ id: 3, status: 'PAID', serviceType: 'PLOMBIER' });
    expect(row.declared).toBeNull();
  });

  it('says what can still go back on a payment that was refunded in part, and nothing on one that was refunded in full', () => {
    expect(paymentListRow(payment({ status: 'PARTIALLY_REFUNDED', amountRefunded: '45.500' }), null).refundable).toBe(74.5);
    expect(paymentListRow(payment({ status: 'REFUNDED', amountRefunded: '120.000' }), null).refundable).toBe(0);
    expect(paymentListRow(payment({ status: 'REFUNDED', amountRefunded: '0.000' }), null).refundable).toBe(0);
  });

  it('never says that a negative sum can go back, whatever the figures say', () => {
    expect(paymentListRow(payment({ status: 'PARTIALLY_REFUNDED', amount: '10.000', amountRefunded: '15.000' }), null).refundable).toBe(0);
  });

  it('has nothing to give back on money that was not received', () => {
    for (const status of ['PENDING', 'AWAITING_CONFIRMATION', 'FAILED', 'CANCELLED']) expect(paymentListRow(payment({ status }), null).refundable).toBe(0);
  });

  it('gives the reason that belongs to the status: why it failed, was cancelled, or was refunded', () => {
    expect(paymentListRow(payment({ status: 'FAILED' }), null).reason).toBe('échec');
    expect(paymentListRow(payment({ status: 'CANCELLED' }), null).reason).toBe('annulé');
    expect(paymentListRow(payment({ status: 'PARTIALLY_REFUNDED' }), null).reason).toBe('remboursé');
    expect(paymentListRow(payment({ status: 'REFUNDED' }), null).reason).toBe('remboursé');
    expect(paymentListRow(payment({ status: 'PAID' }), null).reason).toBeNull();
    expect(paymentListRow(payment({ status: 'PENDING' }), null).reason).toBeNull();
  });

  it('shows the cash an artisan declared, as an amount', () => {
    expect(paymentListRow(payment({ status: 'AWAITING_CONFIRMATION' }), { artisanId: 5, cashAmount: '120.000' }).declared).toEqual({ artisanId: 5, amount: 120 });
  });

  it('copes with a payment whose job has no artisan, no invoice or no customer', () => {
    const row = paymentListRow(payment({ invoice: null, intervention: { id: 3, status: 'CREATED', serviceType: null, client: null, artisan: null } }), null);

    expect(row.invoice).toBeNull();
    expect(row.client).toBeNull();
    expect(row.artisan).toBeNull();
    expect(row.job.serviceType).toBeNull();
  });
});

describe('the filters and rows of the invoices list (P2-08)', () => {
  it('knows its tabs', () => {
    expect([...INVOICE_VIEWS]).toEqual(['all', 'unpaid', 'credited']);
  });

  it('never lists a draft: it is not the customer\'s yet', () => {
    expect(clauses(invoicesWhere({}, NONE))[0]).toEqual({ status: { not: 'DRAFT' } });
  });

  it('holds the invoices that are out and not covered in "unpaid", and the ones with a credit note in "credited"', () => {
    expect(clauses(invoicesWhere({ view: 'unpaid' }, NONE))).toEqual([{ status: { not: 'DRAFT' } }, { status: { in: ['ISSUED', 'SENT'] } }]);
    expect(clauses(invoicesWhere({ view: 'credited' }, NONE))).toEqual([{ status: { not: 'DRAFT' } }, { creditedAmount: { gt: 0 } }]);
  });

  it('puts the period on the day of issue, and a status the caller chose', () => {
    expect(clauses(invoicesWhere({ status: 'PAID' }, WEEK))).toEqual([{ status: { not: 'DRAFT' } }, { status: 'PAID' }, { issuedAt: { gte: WEEK.start, lt: WEEK.end } }]);
  });

  it('looks a search up by the invoice number, the credit note number, the customer and the job', () => {
    const search = clauses(invoicesWhere({ search: 'AV-2026' }, NONE)).pop();

    expect(search.OR).toEqual([
      { invoiceNumber: { contains: 'AV-2026', mode: 'insensitive' } },
      { clientName: { contains: 'AV-2026', mode: 'insensitive' } },
      { clientPhone: { contains: 'AV-2026' } },
      { creditNotes: { some: { creditNoteNumber: { contains: 'AV-2026', mode: 'insensitive' } } } },
    ]);
    expect(clauses(invoicesWhere({ search: '41' }, NONE)).pop().OR.slice(0, 2)).toEqual([{ interventionId: 41 }, { id: 41 }]);
  });

  const invoice = (extra: Record<string, any> = {}) => ({
    id: 9,
    interventionId: 3,
    invoiceNumber: 'F-2026-0009',
    status: 'ISSUED',
    paymentStatus: 'PENDING',
    currency: 'TND',
    amountHT: '100.000',
    taxAmount: '19.000',
    amountTTC: '119.000',
    stampDuty: '1.000',
    creditedAmount: '0.000',
    clientName: 'Ben Salah',
    clientPhone: '20111222',
    mentionsConfirmed: true,
    issuedAt: new Date('2026-10-19T08:00:00Z'),
    creditNotes: [],
    ...extra,
  });

  it('says what is to pay (the total and the stamp duty, less what was credited) and what is left after what the job holds', () => {
    const row = invoiceListRow(invoice(), 80);

    expect(row.toPay).toBe(120);
    expect(row.received).toBe(80);
    expect(row.left).toBe(40);
  });

  it('takes the credit notes off what is to pay', () => {
    const row = invoiceListRow(invoice({ creditedAmount: '59.500', creditNotes: [{ id: 1, creditNoteNumber: 'AV-2026-0001', amountTTC: '59.500', stampDuty: '0.000', reason: 'Remise', issuedAt: new Date('2026-10-20T08:00:00Z') }] }), 0);

    expect(row.credited).toBe(59.5);
    expect(row.toPay).toBe(60.5);
    expect(row.left).toBe(60.5);
    expect(row.creditNotes).toEqual([{ id: 1, number: 'AV-2026-0001', amountTTC: 59.5, stampDuty: 0, reason: 'Remise', issuedAt: new Date('2026-10-20T08:00:00Z') }]);
  });

  it('has nothing left when the job holds more than is owed, and nothing left on a cancelled invoice', () => {
    expect(invoiceListRow(invoice(), 500).left).toBe(0);
    expect(invoiceListRow(invoice({ status: 'CANCELLED' }), 0).left).toBe(0);
  });

  it('does not set an invoice in another currency against the sums of the company', () => {
    expect(invoiceListRow(invoice({ currency: 'EUR' }), 80).left).toBeNull();
  });
});

describe('the CSV of the payments (P2-08)', () => {
  it('shows a text that a spreadsheet would run as a formula as the text it is', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe('"\'=HYPERLINK(""http://x"")"');
    expect(csvCell('+33 6 12')).toBe("'+33 6 12");
    expect(csvCell('-1+1')).toBe("'-1+1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('\t=1')).toBe("'\t=1");
    expect(csvCell('\r=1')).toBe('"\'\r=1"');
  });

  it('leaves an ordinary text, a number and an empty cell as they are', () => {
    expect(csvCell('Ben Salah')).toBe('Ben Salah');
    expect(csvCell(12)).toBe('12');
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell('a=b')).toBe('a=b');
  });

  it('quotes a cell that holds the separator, a quote or a line break, and doubles the quotes', () => {
    expect(csvCell('a;b')).toBe('"a;b"');
    expect(csvCell('dit "oui"')).toBe('"dit ""oui"""');
    expect(csvCell('ligne 1\nligne 2')).toBe('"ligne 1\nligne 2"');
    expect(csvCell('a,b')).toBe('a,b');
  });

  it('writes an amount with three decimals and a comma, as a French spreadsheet reads it', () => {
    expect(csvAmount(120)).toBe('120,000');
    expect(csvAmount('0.5')).toBe('0,500');
    expect(csvAmount(12.345)).toBe('12,345');
    expect(csvAmount(-5)).toBe('-5,000');
    expect(csvAmount(null)).toBe('');
    expect(csvAmount(undefined)).toBe('');
  });

  it('writes a moment on the clock of the business', () => {
    expect(csvMoment(new Date('2026-10-19T08:05:00.000Z'))).toBe('2026-10-19 09:05');
    expect(csvMoment(new Date('2026-10-19T23:00:00.000Z'))).toBe('2026-10-20 00:00');
    expect(csvMoment('2026-10-19T08:05:00.000Z')).toBe('2026-10-19 09:05');
    expect(csvMoment(null)).toBe('');
    expect(csvMoment('pas une date')).toBe('');
  });

  const rows = () => {
    const base = {
      id: 7,
      interventionId: 3,
      method: 'CASH',
      provider: 'CASH',
      status: 'PAID',
      amount: 120,
      amountRefunded: 0,
      currency: 'TND',
      reference: null,
      receiptNumber: 'R-1',
      adminNote: null,
      requestedAt: new Date('2026-10-19T08:00:00Z'),
      confirmedAt: new Date('2026-10-19T09:00:00Z'),
      invoice: null,
      intervention: { id: 3, status: 'PAID', serviceType: 'PLOMBIER', client: { id: 4, name: '=cmd|\'/c calc\'!A1', phone: '+21620111222' }, artisan: { id: 5, name: 'Artisan' } },
    };

    return [paymentListRow(base, null), paymentListRow({ ...base, id: 8, amount: 12.5, adminNote: 'vu;ok', intervention: { ...base.intervention, client: { id: 4, name: 'Ben "Bob" Salah', phone: null } } }, null)];
  };

  it('starts with a byte-order mark, ends its lines like Windows, and has a header', () => {
    const csv = paymentsCsv(rows());

    expect(csv.startsWith('﻿Paiement;Mission;Demandé le;Confirmé le;Client;Téléphone;Technicien;Mode;Statut;Montant;Remboursé;Remboursé le;Devise;Référence;Reçu;Facture;Motif;Note interne\r\n')).toBe(true);
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv.split('\r\n')).toHaveLength(4);
  });

  it('shows a customer name or a phone number that starts like a formula as text', () => {
    const [, first] = paymentsCsv(rows()).split('\r\n');

    expect(first).toContain(";'=cmd|'/c calc'!A1;");
    expect(first).toContain(";'+21620111222;");
    expect(first.startsWith("7;3;2026-10-19 09:00;2026-10-19 10:00;")).toBe(true);
  });

  it('writes the amounts as numbers: a comma, never a sign-guard quote', () => {
    const [, first, second] = paymentsCsv(rows()).split('\r\n');

    expect(first).toContain(';120,000;0,000;;TND;');
    expect(second).toContain(';12,500;0,000;;TND;');
  });

  it('keeps the separator and the quotes of a note inside their cell', () => {
    const [, , second] = paymentsCsv(rows()).split('\r\n');

    expect(second).toContain('"Ben ""Bob"" Salah"');
    expect(second.endsWith(';"vu;ok"')).toBe(true);
  });

  it('is only a header when there are no payments', () => {
    expect(paymentsCsv([]).split('\r\n')).toHaveLength(2);
  });
});

describe('every column of the payments file (P2-08)', () => {
  const full = (extra: Record<string, any> = {}) => ({
    id: 7,
    interventionId: 3,
    method: 'BANK_TRANSFER',
    provider: 'MANUAL',
    status: 'PARTIALLY_REFUNDED',
    amount: 300,
    amountRefunded: 100,
    currency: 'TND',
    reference: 'VIR-1',
    receiptNumber: 'R-9',
    adminNote: 'note',
    failureReason: null,
    cancelReason: null,
    refundReason: 'Geste',
    requestedAt: new Date('2026-10-19T08:00:00Z'),
    confirmedAt: new Date('2026-10-19T09:00:00Z'),
    refundedAt: new Date('2026-10-20T10:00:00Z'),
    invoice: { id: 2, invoiceNumber: 'F-2026-0002', status: 'ISSUED' },
    intervention: { id: 3, status: 'PAID', serviceType: 'PLOMBIER', client: { id: 4, name: 'Ben Salah', phone: '20111222' }, artisan: { id: 5, name: 'Karim' } },
    ...extra,
  });

  const line = (row: Record<string, any>) => paymentsCsv([paymentListRow(row, null)]).split('\r\n')[1];

  it('puts each figure in its own column, in the order of the header', () => {
    expect(line(full())).toBe('7;3;2026-10-19 09:00;2026-10-19 10:00;Ben Salah;20111222;Karim;BANK_TRANSFER;PARTIALLY_REFUNDED;300,000;100,000;2026-10-20 11:00;TND;VIR-1;R-9;F-2026-0002;Geste;note');
  });

  it('leaves empty what a payment does not have, without moving the other columns', () => {
    const bare = full({ reference: null, receiptNumber: null, adminNote: null, refundReason: null, refundedAt: null, status: 'PAID', amountRefunded: 0, invoice: null, confirmedAt: null, intervention: { id: 3, status: 'PAID', serviceType: 'PLOMBIER', client: null, artisan: null } });

    expect(line(bare)).toBe('7;3;2026-10-19 09:00;;;;;BANK_TRANSFER;PAID;300,000;0,000;;TND;;;;;');
  });

  it('shows every text that starts like a formula as text: the reference, the receipt, the reason, the note, the names', () => {
    const risky = line(
      full({
        reference: '=1+1',
        receiptNumber: '@SUM(A1)',
        adminNote: '-2+3',
        refundReason: '+cmd',
        intervention: { id: 3, status: 'PAID', serviceType: 'PLOMBIER', client: { id: 4, name: '=A1', phone: '+216 20 111 222' }, artisan: { id: 5, name: '@Karim' } },
      }),
    );

    expect(risky).toBe("7;3;2026-10-19 09:00;2026-10-19 10:00;'=A1;'+216 20 111 222;'@Karim;BANK_TRANSFER;PARTIALLY_REFUNDED;300,000;100,000;2026-10-20 11:00;TND;'=1+1;'@SUM(A1);F-2026-0002;'+cmd;'-2+3");
  });

  it('keeps an amount a number even when it carries a sign, so that a spreadsheet adds it up', () => {
    expect(line(full({ amount: -5, amountRefunded: -2 }))).toContain(';-5,000;-2,000;2026-10-20 11:00;TND;');
  });
});

/** Whether a list of conditions holds this one (the test harness has no toContainEqual). */
const has = (list: any[], item: unknown) => list.some((entry) => JSON.stringify(entry) === JSON.stringify(item));

describe('the search text and the tabs that ignore the period (review of P2-08)', () => {
  it('writes a percent sign, an underscore and a backslash as the letters they are in a contains', () => {
    expect(likeLiteral('50%')).toBe('50\\%');
    expect(likeLiteral('VIR_1')).toBe('VIR\\_1');
    expect(likeLiteral('a\\b')).toBe('a\\\\b');
    expect(likeLiteral('F-2026-0001')).toBe('F-2026-0001');
    expect(has(clauses(paymentsWhere({ search: '50%' }, NONE))[0].OR, { reference: { contains: '50\\%', mode: 'insensitive' } })).toBe(true);
    expect(has(clauses(invoicesWhere({ search: 'A_B' }, NONE)).pop().OR, { invoiceNumber: { contains: 'A\\_B', mode: 'insensitive' } })).toBe(true);
  });

  it('drops a NUL byte from a search: PostgreSQL refuses it in a text', () => {
    expect(searchText('a\u0000b')).toBe('ab');
    expect(searchText('\u0000')).toBeNull();
    expect(searchText(' \u0000 ')).toBeNull();
    expect(paymentsWhere({ search: '\u0000' }, NONE)).toEqual({});
  });

  it('cuts a search at the hundredth letter and trims what is left, and trims what comes before it first', () => {
    // a space at the cut leaves a trailing space that is trimmed; spaces before the text do not take letters of the hundred
    expect(searchText(`${'a'.repeat(99)} b`)).toBe('a'.repeat(99));
    expect(searchText(`   ${'a'.repeat(100)}`)).toBe('a'.repeat(100));
    expect(searchText(`  ${'a'.repeat(100)}  `)).toBe('a'.repeat(100));
  });

  it('writes a search that is not a phone number as letters in the phone column too', () => {
    const phone = (contains: string) => ({ intervention: { client: { phone: { contains } } } });

    expect(has(clauses(paymentsWhere({ search: '50%' }, NONE))[0].OR, phone('50\\%'))).toBe(true);
    expect(has(clauses(paymentsWhere({ search: 'a_b' }, NONE))[0].OR, phone('a\\_b'))).toBe(true);
    expect(has(clauses(invoicesWhere({ search: '50%' }, NONE)).pop().OR, { clientPhone: { contains: '50\\%' } })).toBe(true);
  });

  it('looks a phone number up as the person typed it, by its digits, by the local number, spaced, and by the key of the account', () => {
    const payments = clauses(paymentsWhere({ search: '+216 22 123 456' }, NONE))[0].OR;
    const phone = (contains: string) => ({ intervention: { client: { phone: { contains } } } });

    expect(has(payments, phone('+216 22 123 456'))).toBe(true);
    expect(has(payments, phone('21622123456'))).toBe(true);
    expect(has(payments, phone('22123456'))).toBe(true);
    expect(has(payments, phone('22 123 456'))).toBe(true);
    expect(has(payments, { intervention: { client: { phoneKey: { contains: '21622123456' } } } })).toBe(true);

    const invoices = clauses(invoicesWhere({ search: '22123456' }, NONE)).pop().OR;

    expect(has(invoices, { clientPhone: { contains: '22 123 456' } })).toBe(true);
    expect(has(invoices, { intervention: { client: { phoneKey: { contains: '22123456' } } } })).toBe(true);
  });

  it('looks text that is not a phone number up as it is, and a short number as it is', () => {
    expect(clauses(paymentsWhere({ search: 'Ben' }, NONE))[0].OR.filter((condition: any) => condition.intervention?.client?.phone)).toEqual([{ intervention: { client: { phone: { contains: 'Ben' } } } }]);
    expect(clauses(paymentsWhere({ search: '12' }, NONE))[0].OR.some((condition: any) => condition.intervention?.client?.phoneKey)).toBe(false);
  });

  it('shows what waits whatever the period: the awaiting payments and the unpaid invoices, and tells that the period did not apply', () => {
    expect(paymentPeriodApplies('awaiting', WEEK)).toBe(false);
    expect(paymentPeriodApplies('received', WEEK)).toBe(true);
    expect(paymentPeriodApplies('refunded', WEEK)).toBe(true);
    expect(paymentPeriodApplies('all', WEEK)).toBe(true);
    expect(paymentPeriodApplies('received', NONE)).toBe(false);
    expect(invoicePeriodApplies('unpaid', WEEK)).toBe(false);
    expect(invoicePeriodApplies('credited', WEEK)).toBe(true);
    expect(invoicePeriodApplies('all', WEEK)).toBe(true);
    expect(invoicePeriodApplies('all', NONE)).toBe(false);
    expect(clauses(invoicesWhere({ view: 'unpaid' }, WEEK))).toEqual([{ status: { not: 'DRAFT' } }, { status: { in: ['ISSUED', 'SENT'] } }]);
  });

  it('dates the credited tab by the credit note, not by the invoice', () => {
    const window = { gte: WEEK.start, lt: WEEK.end };

    expect(clauses(invoicesWhere({ view: 'credited' }, WEEK))).toEqual([{ status: { not: 'DRAFT' } }, { creditNotes: { some: { issuedAt: window } } }]);
    expect(clauses(invoicesWhere({ view: 'credited' }, NONE))).toEqual([{ status: { not: 'DRAFT' } }, { creditedAmount: { gt: 0 } }]);
  });

  it('counts as issued every invoice that is not a draft, except one cancelled with nothing credited', () => {
    const window = { gte: WEEK.start, lt: WEEK.end };

    expect(issuedInvoicesWhere('TND', window)).toEqual({
      currency: 'TND',
      issuedAt: window,
      status: { not: 'DRAFT' },
      OR: [{ status: { not: 'CANCELLED' } }, { creditedAmount: { gt: 0 } }],
    });
  });

  it('asks nothing of an invoice that was cancelled, whatever its figures say', () => {
    const row = invoiceListRow({ id: 1, interventionId: 2, invoiceNumber: 'F-1', status: 'CANCELLED', paymentStatus: 'PENDING', currency: 'TND', amountTTC: '500.000', stampDuty: '1.000', creditedAmount: '0.000' }, 0);

    expect(row).toMatchObject({ toPay: 0, left: 0 });
  });

  it('gives the refunded amount as the summary counts it: all of a payment marked as refunded', () => {
    const base = { id: 1, interventionId: 2, method: 'CASH', provider: 'CASH', amount: '40.000', currency: 'TND' };

    expect(paymentListRow({ ...base, status: 'REFUNDED', amountRefunded: '0.000' }, null)).toMatchObject({ amountRefunded: 40, refundable: 0 });
    expect(paymentListRow({ ...base, status: 'PARTIALLY_REFUNDED', amountRefunded: '12.000' }, null)).toMatchObject({ amountRefunded: 12, refundable: 28 });
    expect(paymentListRow({ ...base, status: 'PAID', amountRefunded: '0.000' }, null)).toMatchObject({ amountRefunded: 0, refundable: 40 });
  });
});
