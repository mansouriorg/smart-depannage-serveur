/**
 * The totals of a quote and of an invoice (P2-01): one place, exact to the millime.
 *
 * Before, the quotes and the invoices each had their own `roundMoney` (two decimals, through a float product) and their
 * own totals; 12.345 became 12.35 and `1.005 * 100` was 100.49999. Now a line is `unitPrice x quantity` in whole millimes,
 * the amount without tax is the sum of the lines, the tax is rounded once, and the total is exactly the two added.
 */
import { BadRequestException } from '@nestjs/common';

import { getLocale } from '../locale/locale';
import { isDecimal } from './money-numbers';
import { MAX_COLUMN_AMOUNT, MoneyInput, money, multiplyMoney, sumMoneyOf, vatTotals } from './money';

export type DocumentKind = 'quote' | 'invoice';

export interface DocumentItemInput {
  label?: string | null;
  description?: string | null;
  quantity?: unknown;
  unitPrice?: unknown;
}

export interface DocumentItem {
  label: string;
  description?: string | null;
  quantity: number;
  unitPrice: number;
  total: number;
}

export interface DocumentTotals {
  amountHT: number;
  taxRate: number;
  taxAmount: number;
  amountTTC: number;
}

const WORDS: Record<DocumentKind, { empty: string; label: string }> = {
  quote: { empty: 'Le devis doit contenir au moins une ligne.', label: 'Chaque ligne du devis doit avoir un libellé.' },
  invoice: { empty: 'La facture doit contenir au moins une ligne.', label: 'Chaque ligne de facture doit avoir un libellé.' },
};

const TOO_BIG = 'Le montant dépasse le maximum autorisé.';

function isMissing(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

/** An amount that the person typed: a refusal (400) for anything that is not an amount, never a quiet zero. */
export function requestAmount(value: unknown, message: string): number {
  if (isMissing(value) || (typeof value === 'number' && !Number.isFinite(value))) throw new BadRequestException(message);

  try {
    return money(value as MoneyInput);
  } catch {
    throw new BadRequestException(message);
  }
}

function assertFits(amount: number): void {
  if (Math.abs(amount) > MAX_COLUMN_AMOUNT) throw new BadRequestException(TOO_BIG);
}

/** The rate (percent) to use: the one given, else the one of the company settings. A rate is from 0 to 100 with at most two decimals. */
export function requestTaxRate(rate: unknown, message: string, fallback: unknown = getLocale().defaultTaxRate): number {
  const value = isMissing(rate) ? fallback : rate;
  // A rate is a number or a text that holds one: Number([]) and Number(true) are not rates.
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : isDecimal(value) ? Number(String(value)) : NaN;

  if (!Number.isFinite(parsed) || parsed < 0) throw new BadRequestException(message);
  if (parsed > 100 || Math.round(parsed * 100) / 100 !== parsed) {
    throw new BadRequestException('Le taux de TVA doit être compris entre 0 et 100, avec au plus deux décimales.');
  }

  return parsed;
}

/** The totals of an amount without tax. */
export function totalsFromAmount(amountHT: unknown, taxRate: unknown, options: { invalidAmount?: string; invalidRate?: string } = {}): DocumentTotals {
  const ht = requestAmount(amountHT, options.invalidAmount ?? 'Montant HT invalide.');

  if (ht <= 0) throw new BadRequestException(options.invalidAmount ?? 'Montant HT invalide.');

  const rate = requestTaxRate(taxRate, options.invalidRate ?? 'Taux de TVA invalide.');
  const totals = vatTotals(ht, rate);

  assertFits(totals.amountTTC);

  return { ...totals, taxRate: rate };
}

/** The lines and the totals of a quote or an invoice. */
export function totalsFromItems(kind: DocumentKind, items: DocumentItemInput[] | null | undefined, taxRate: unknown, invalidRate = 'Le taux de TVA doit être supérieur ou égal à 0.'): DocumentTotals & { items: DocumentItem[] } {
  if (!items?.length) throw new BadRequestException(WORDS[kind].empty);

  const lines = items.map((item): DocumentItem => {
    if (!item.label?.trim()) throw new BadRequestException(WORDS[kind].label);

    const quantity = isMissing(item.quantity) ? NaN : Number(item.quantity);

    if (!Number.isFinite(quantity) || quantity <= 0) throw new BadRequestException('La quantité doit être supérieure à 0.');

    const unitPrice = requestAmount(item.unitPrice, 'Le prix unitaire doit être supérieur ou égal à 0.');

    if (unitPrice < 0) throw new BadRequestException('Le prix unitaire doit être supérieur ou égal à 0.');

    let total: number;

    try {
      total = multiplyMoney(unitPrice, quantity);
    } catch {
      throw new BadRequestException(TOO_BIG);
    }

    assertFits(total);

    return { label: item.label, description: item.description, quantity, unitPrice, total };
  });

  const amountHT = sumMoneyOf(lines.map((line) => line.total));
  const rate = requestTaxRate(taxRate, invalidRate);
  const totals = vatTotals(amountHT, rate);

  assertFits(totals.amountTTC);

  return { ...totals, taxRate: rate, items: lines };
}
