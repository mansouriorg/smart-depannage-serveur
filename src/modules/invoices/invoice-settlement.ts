/**
 * Whether an invoice is paid (P2-07): one rule, worked out from the payments of the job, in the transaction that changes them.
 *
 * An invoice is paid when what the customer kept (what was received less what went back) covers what is to be paid on it: its
 * total, plus its stamp duty, less what the credit notes took off. Not when "a payment of some part of it was confirmed" (a
 * deposit), and not for good: a refund that is not matched by a credit note leaves the invoice unpaid again, with the amount that
 * is missing asked for on the tracking page, which is how the payment position of the job has always read it.
 *
 * An invoice that was cancelled stays cancelled, whatever the payments do. A draft is not the customer's yet: it is left alone.
 * An invoice in another currency than the company's cannot be compared with the sums of the company: a payment that was received
 * settles it.
 */
import { compareMoney } from '../../common/money/money';
import { currencyCode } from '../../common/locale/locale';
import { RECEIVED_PAYMENT_STATUSES, amountToPay, liveInvoiceOf, paymentFigures } from '../payments/financials-ops';

type Db = any;
type Row = Record<string, any>;

/** The payments that settle an invoice in another currency: money that was received and not given back in full. */
const SETTLING_PAYMENT_STATUSES: readonly string[] = ['PAID', 'PARTIALLY_REFUNDED'];

/** Whether the payments of the job cover what is to be paid on the invoice. */
export function invoiceIsCovered(invoice: Row, payments: Row[]): boolean {
  if (invoice.currency && String(invoice.currency) !== currencyCode()) return payments.some((payment) => SETTLING_PAYMENT_STATUSES.includes(String(payment.status)));

  return compareMoney(paymentFigures(payments).kept, amountToPay(invoice)) >= 0;
}

/** The payment status the invoice shows: PAID when covered; else REFUNDED / PARTIALLY_REFUNDED when money went back; else PENDING. */
export function invoicePaymentStatus(invoice: Row, payments: Row[]): 'PAID' | 'REFUNDED' | 'PARTIALLY_REFUNDED' | 'PENDING' {
  if (invoiceIsCovered(invoice, payments)) return 'PAID';

  const counted = payments.filter((payment) => RECEIVED_PAYMENT_STATUSES.includes(String(payment.status)));

  if (counted.length === 0) return 'PENDING';

  const figures = paymentFigures(counted);

  if (compareMoney(figures.refunded, 0) <= 0) return 'PENDING';

  return compareMoney(figures.kept, 0) <= 0 ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
}

/**
 * Brings the live invoice of the job in line with its payments. Returns the invoice as it is afterwards, or null when the job has
 * no live invoice. Call it inside the transaction that changes the payments (or the invoice), after taking the lock of the job.
 */
export async function settleInvoice(db: Db, interventionId: number, now: Date = new Date()): Promise<Row | null> {
  const invoice = await liveInvoiceOf(db, interventionId);

  if (!invoice) return null;

  const payments: Row[] = await db.payment.findMany({ where: { interventionId } });
  const covered = invoiceIsCovered(invoice, payments);
  const paymentStatus = invoicePaymentStatus(invoice, payments);
  const data: Row = {};

  if (covered) {
    if (String(invoice.status) !== 'PAID') {
      data.status = 'PAID';
      data.paidAt = now;
    } else if (!invoice.paidAt) {
      data.paidAt = now;
    }
  } else if (String(invoice.status) === 'PAID') {
    // No longer covered (money went back with no credit note): it asks for the rest again, as it was before it was paid.
    data.status = invoice.sentAt ? 'SENT' : 'ISSUED';
    data.paidAt = null;
  }

  if (String(invoice.paymentStatus) !== paymentStatus) data.paymentStatus = paymentStatus;

  if (Object.keys(data).length === 0) return invoice;

  return db.invoice.update({ where: { id: invoice.id }, data });
}
