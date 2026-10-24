import { applyLocale, resetLocale } from '../../common/locale/locale';
import { MemoryPrisma } from '../../common/testing/memory-prisma';
import { invoiceIsCovered, invoicePaymentStatus, settleInvoice } from './invoice-settlement';

/** The paid rule alone (P2-07): paid when what the customer kept covers what is to be paid, from the payments of the job. */
const invoice = (extra: Record<string, unknown> = {}) => ({ amountTTC: 120, creditedAmount: 0, stampDuty: 0, currency: 'TND', status: 'ISSUED', paymentStatus: 'PENDING', ...extra });
const payment = (amount: number, status = 'PAID', amountRefunded = 0, extra: Record<string, unknown> = {}) => ({ amount, status, amountRefunded, currency: 'TND', ...extra });

describe('whether the payments cover an invoice', () => {
  it('is not covered by nothing, nor by a part', () => {
    expect(invoiceIsCovered(invoice(), [])).toBe(false);
    expect(invoiceIsCovered(invoice(), [payment(40)])).toBe(false);
    expect(invoiceIsCovered(invoice(), [payment(119.999)])).toBe(false);
  });

  it('is covered by the total, or by payments that add up to it, or by more', () => {
    expect(invoiceIsCovered(invoice(), [payment(120)])).toBe(true);
    expect(invoiceIsCovered(invoice(), [payment(40), payment(80)])).toBe(true);
    expect(invoiceIsCovered(invoice(), [payment(200)])).toBe(true);
  });

  it('counts the stamp duty and takes the credit notes off', () => {
    expect(invoiceIsCovered(invoice({ stampDuty: 1 }), [payment(120)])).toBe(false);
    expect(invoiceIsCovered(invoice({ stampDuty: 1 }), [payment(121)])).toBe(true);
    expect(invoiceIsCovered(invoice({ creditedAmount: 20 }), [payment(100)])).toBe(true);
    expect(invoiceIsCovered(invoice({ creditedAmount: 20 }), [payment(99.999)])).toBe(false);
  });

  it('counts only what was received, and not what went back', () => {
    expect(invoiceIsCovered(invoice(), [payment(120, 'PENDING')])).toBe(false);
    expect(invoiceIsCovered(invoice(), [payment(120, 'FAILED')])).toBe(false);
    expect(invoiceIsCovered(invoice(), [payment(120, 'REFUNDED', 120)])).toBe(false);
    expect(invoiceIsCovered(invoice(), [payment(120, 'PARTIALLY_REFUNDED', 20)])).toBe(false);
    expect(invoiceIsCovered(invoice(), [payment(150, 'PARTIALLY_REFUNDED', 30)])).toBe(true);
  });

  it('is settled by a received payment when the invoice is in another currency than the company\'s', () => {
    expect(invoiceIsCovered(invoice({ currency: 'EUR' }), [payment(1)])).toBe(true);
    expect(invoiceIsCovered(invoice({ currency: 'EUR' }), [payment(1, 'REFUNDED', 1)])).toBe(false);
    expect(invoiceIsCovered(invoice({ currency: 'EUR' }), [payment(1, 'PENDING')])).toBe(false);
  });
});

describe('the payment status an invoice shows', () => {
  it('is PAID when covered, PENDING when nothing was received', () => {
    expect(invoicePaymentStatus(invoice(), [payment(120)])).toBe('PAID');
    expect(invoicePaymentStatus(invoice(), [])).toBe('PENDING');
    expect(invoicePaymentStatus(invoice(), [payment(40)])).toBe('PENDING');
    expect(invoicePaymentStatus(invoice(), [payment(120, 'PENDING')])).toBe('PENDING');
  });

  it('says REFUNDED when all went back, PARTIALLY_REFUNDED when some did and less than the total is kept', () => {
    expect(invoicePaymentStatus(invoice(), [payment(120, 'REFUNDED', 120)])).toBe('REFUNDED');
    expect(invoicePaymentStatus(invoice(), [payment(120, 'PARTIALLY_REFUNDED', 20)])).toBe('PARTIALLY_REFUNDED');
  });
});

describe('settling the invoice of a job', () => {
  const setup = (invoiceExtra: Record<string, unknown> = {}, payments: Array<Record<string, unknown>> = []) => {
    const memory = new MemoryPrisma();
    const db = memory.client();
    const client = memory.plant('user', { role: 'CLIENT' });
    const job = memory.plant('intervention', { clientId: client.id, status: 'COMPLETED' });
    memory.plant('invoice', { interventionId: job.id, invoiceNumber: 'F-2026-0001', numberYear: 2026, sequence: 1, amountHT: 100, taxRate: 20, taxAmount: 20, amountTTC: 120, status: 'ISSUED', paymentStatus: 'PENDING', ...invoiceExtra });

    for (const entry of payments) memory.plant('payment', { interventionId: job.id, method: 'CASH', currency: 'TND', ...entry });

    // `plant` hands back a copy: the row to look at is the one in the table.
    return { memory, db, job, get row() { return memory.rows('invoice')[0]; } };
  };
  const NOW = new Date('2026-10-24T10:00:00Z');

  beforeEach(() => resetLocale());

  it('marks the invoice paid, with the day, when the payments cover it', async () => {
    const { db, job, row } = setup({}, [{ amount: 120, status: 'PAID' }]);
    const settled = await settleInvoice(db, job.id, NOW);

    expect([settled?.status, settled?.paymentStatus, settled?.paidAt]).toEqual(['PAID', 'PAID', NOW]);
    expect(row.status).toBe('PAID');
  });

  it('leaves it as it is for a deposit, but says that money went back when it did', async () => {
    const { db, job, row } = setup({}, [{ amount: 40, status: 'PAID' }]);

    await settleInvoice(db, job.id, NOW);
    expect([row.status, row.paymentStatus, row.paidAt ?? null]).toEqual(['ISSUED', 'PENDING', null]);
  });

  it('keeps the day it was paid, and fills it if it was missing', async () => {
    const day = new Date('2026-10-01T08:00:00Z');
    const first = setup({ status: 'PAID', paymentStatus: 'PAID', paidAt: day }, [{ amount: 120, status: 'PAID' }]);
    const second = setup({ status: 'PAID', paymentStatus: 'PAID', paidAt: null }, [{ amount: 120, status: 'PAID' }]);

    await settleInvoice(first.db, first.job.id, NOW);
    await settleInvoice(second.db, second.job.id, NOW);

    expect(first.row.paidAt).toEqual(day);
    expect(second.row.paidAt).toEqual(NOW);
  });

  it('sends a paid invoice back to what it was before when money went back: SENT if it had been sent, else ISSUED', async () => {
    const sent = setup({ status: 'PAID', paymentStatus: 'PAID', paidAt: NOW, sentAt: new Date('2026-10-02T00:00:00Z') }, [{ amount: 120, status: 'PARTIALLY_REFUNDED', amountRefunded: 20 }]);
    const issued = setup({ status: 'PAID', paymentStatus: 'PAID', paidAt: NOW, sentAt: null }, [{ amount: 120, status: 'REFUNDED', amountRefunded: 120 }]);

    await settleInvoice(sent.db, sent.job.id, NOW);
    await settleInvoice(issued.db, issued.job.id, NOW);

    expect([sent.row.status, sent.row.paymentStatus, sent.row.paidAt]).toEqual(['SENT', 'PARTIALLY_REFUNDED', null]);
    expect([issued.row.status, issued.row.paymentStatus, issued.row.paidAt]).toEqual(['ISSUED', 'REFUNDED', null]);
  });

  it('leaves a cancelled invoice and a draft alone, whatever the payments do, and returns nothing for a job with no invoice', async () => {
    const cancelled = setup({ status: 'CANCELLED' }, [{ amount: 120, status: 'PAID' }]);
    const draft = setup({ status: 'DRAFT' }, [{ amount: 120, status: 'PAID' }]);
    const none = setup({ status: 'CANCELLED' });

    expect(await settleInvoice(cancelled.db, cancelled.job.id, NOW)).toBeNull();
    expect(await settleInvoice(draft.db, draft.job.id, NOW)).toBeNull();
    expect(await settleInvoice(none.db, none.job.id, NOW)).toBeNull();
    expect([cancelled.row.status, draft.row.status]).toEqual(['CANCELLED', 'DRAFT']);
  });

  it('settles the newest live invoice, not the one that was cancelled before it', async () => {
    const { memory, db, job } = setup({ status: 'CANCELLED', invoiceNumber: 'F-2026-0001' }, [{ amount: 120, status: 'PAID' }]);
    memory.plant('invoice', { interventionId: job.id, invoiceNumber: 'F-2026-0002', numberYear: 2026, sequence: 2, amountHT: 100, taxRate: 20, taxAmount: 20, amountTTC: 120, status: 'ISSUED', paymentStatus: 'PENDING' });

    await settleInvoice(db, job.id, NOW);

    expect(memory.rows('invoice').map((row) => [row.invoiceNumber, row.status])).toEqual([['F-2026-0001', 'CANCELLED'], ['F-2026-0002', 'PAID']]);
  });

  it('works on the figures of the company: a company that is not in dinars compares in its own currency', async () => {
    applyLocale({ currency: 'EUR' } as any);

    const { db, job, row } = setup({ currency: 'EUR' }, [{ amount: 120, currency: 'EUR', status: 'PAID' }]);

    await settleInvoice(db, job.id, NOW);
    expect(row.status).toBe('PAID');
  });
});
