/**
 * The amounts of a credit note (P2-07): exact to the millime, and never more than what is left of the invoice.
 *
 * A credit note takes back all or part of an invoice. The total it takes back (TTC) is what the person asks, or all that is left of
 * the invoice. For the part that closes the invoice, the amounts are the invoice's own less what the earlier credit notes took
 * (a subtraction, so that everything the credit notes took adds up to the invoice to the millime). A part that leaves something
 * is split at the rate of the invoice: the amount without tax is the total over (1 + rate), the tax is the rest.
 *
 * The stamp duty (timbre fiscal) of the invoice goes back with the credit note that closes it, and only with that one.
 */
import { BadRequestException } from '@nestjs/common';

import { compareMoney, money, proportionOf, subtractMoney, sumMoney, sumMoneyOf } from '../../common/money/money';

type Row = Record<string, any>;

export interface CreditNoteTotals {
  amountHT: number;
  taxRate: number;
  taxAmount: number;
  amountTTC: number;
  stampDuty: number;
  /** Whether this credit note takes back all that was left of the invoice. */
  closes: boolean;
}

/** What the earlier credit notes of an invoice took off, and what is left of it. */
export function creditableOf(invoice: Row, previous: Row[]) {
  const taken = (field: string) => sumMoneyOf(previous.map((note) => note[field] ?? 0));

  return {
    amountTTC: subtractMoney(invoice.amountTTC, taken('amountTTC')),
    amountHT: subtractMoney(invoice.amountHT, taken('amountHT')),
    taxAmount: subtractMoney(invoice.taxAmount, taken('taxAmount')),
    stampDuty: subtractMoney(invoice.stampDuty ?? 0, taken('stampDuty')),
  };
}

export const CREDIT_WORDS = {
  amount: 'Le montant de l’avoir doit être supérieur à 0.',
  tooMuch: 'Le montant de l’avoir dépasse ce qu’il reste à créditer sur cette facture.',
  nothingLeft: 'Cette facture est déjà créditée en totalité.',
};

/** The totals of a credit note of `requested` (the TTC to take back; all that is left when it is not given). */
export function creditNoteTotals(invoice: Row, previous: Row[], requested?: unknown): CreditNoteTotals {
  const left = creditableOf(invoice, previous);

  if (compareMoney(left.amountTTC, 0) <= 0) throw new BadRequestException(CREDIT_WORDS.nothingLeft);

  const wanted = requested === undefined || requested === null || requested === '' ? left.amountTTC : money(requested as any);

  if (compareMoney(wanted, 0) <= 0) throw new BadRequestException(CREDIT_WORDS.amount);
  if (compareMoney(wanted, left.amountTTC) > 0) throw new BadRequestException(CREDIT_WORDS.tooMuch);

  const taxRate = money(invoice.taxRate);

  if (compareMoney(wanted, left.amountTTC) === 0) {
    return { amountHT: left.amountHT, taxRate, taxAmount: left.taxAmount, amountTTC: left.amountTTC, stampDuty: left.stampDuty, closes: true };
  }

  // A part: the amount without tax is the total over (1 + rate), the tax is the rest; neither goes over what is left of the invoice.
  let amountHT = proportionOf(wanted, 100, sumMoney(100, taxRate));
  let taxAmount = subtractMoney(wanted, amountHT);

  if (compareMoney(taxAmount, left.taxAmount) > 0) {
    taxAmount = left.taxAmount;
    amountHT = subtractMoney(wanted, taxAmount);
  }

  if (compareMoney(amountHT, left.amountHT) > 0) {
    amountHT = left.amountHT;
    taxAmount = subtractMoney(wanted, amountHT);
  }

  return { amountHT, taxRate, taxAmount, amountTTC: wanted, stampDuty: 0, closes: false };
}
