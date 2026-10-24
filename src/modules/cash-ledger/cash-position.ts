/**
 * What is left to take on a job, for the artisan who holds it (P2-05). A file of its own because it needs the rules of the open
 * payments (`payments/open-payment`), which themselves read the payment position of the ops: the ops cannot import them back.
 */
import { currencyCode } from '../../common/locale/locale';
import { compareMoney, money, sumMoney } from '../../common/money/money';
import { canonicalStatus } from '../intervention-workflow/intervention-status';
import { describeAmount, paymentsInTheWayOfCash } from '../payments/open-payment';
import { COLLECT_CASH_IN, COLLECT_CASH_WORDS, CashPositionView, foreignCurrencyWords, openPaymentWords } from './cash-ledger.types';
import { activeCollections, jobIsInPaidPayout, paymentPosition } from './cash-ledger-ops';

type Db = any;

/**
 * What is left to take on a job, as the artisan who holds it reads it (P2-05). The reasons are checked in the order in which the
 * collection checks them, and say the same words, so that a button the screen shows is one the server accepts.
 * It only reads: nothing is locked, so the figures are a hint and the collection decides.
 */
export async function cashPositionOf(db: Db, job: { id: number; status: unknown }, artisanId: number): Promise<CashPositionView> {
  const position = await paymentPosition(db, job.id);
  const mine = await activeCollections(db, { interventionId: job.id, artisanId });
  const collected = mine.reduce<number>((total, entry) => sumMoney(total, money(entry.cashAmount)), 0);
  const document = position.document;
  const ledgerCurrency = currencyCode();
  const currency: string = document?.currency ?? ledgerCurrency;
  const status = canonicalStatus(String(job.status));

  let reason: string | null = null;

  if (!status || !COLLECT_CASH_IN.includes(status)) reason = COLLECT_CASH_WORDS.wrongStatus;
  else if (await jobIsInPaidPayout(db, job.id)) reason = COLLECT_CASH_WORDS.inPaidPayout;
  else if (!document || position.remaining === null) reason = COLLECT_CASH_WORDS.noDocument;
  else if (currency !== ledgerCurrency) reason = foreignCurrencyWords(currency, ledgerCurrency);
  else if (compareMoney(position.remaining, 0) <= 0) reason = COLLECT_CASH_WORDS.alreadyPaid;
  else {
    // Another way of paying is open (a transfer waiting for its confirmation, an online payment someone can pay): the collection refuses.
    const { blocking } = paymentsInTheWayOfCash(position.payments);

    if (blocking) reason = openPaymentWords(describeAmount(blocking));
  }

  return {
    interventionId: job.id,
    currency,
    document: position.invoice ? 'INVOICE' : position.quote ? 'QUOTE' : null,
    total: document ? money(document.amountTTC) : null,
    received: position.received,
    remaining: position.remaining,
    collected,
    canCollect: reason === null,
    reason,
  };
}
