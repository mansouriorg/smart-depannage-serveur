/**
 * Validation of what a person types as an amount or a rate (P2-01).
 *
 * An amount has at most three decimals (millimes) and fits the column that keeps it; a rate is a percent with at most
 * two decimals. Anything else is refused with a 400, never rounded in silence. The rules themselves are in `money-rules`.
 */
import { ValidateBy } from 'class-validator';

import { MAX_COLUMN_AMOUNT } from './money';
import { isValidAmount, isValidTaxRate } from './money-rules';

export function IsMoney(options: { min?: number } = {}) {
  const min = options.min ?? 0;

  return ValidateBy({
    name: 'isMoney',
    constraints: [min, MAX_COLUMN_AMOUNT],
    validator: {
      validate: (value: unknown) => isValidAmount(value, min),
      defaultMessage: (args?: { property?: string }) => `${args?.property ?? 'value'} must be an amount from ${min} to ${MAX_COLUMN_AMOUNT} with at most 3 decimals`,
    },
  });
}

export function IsTaxRate() {
  return ValidateBy({
    name: 'isTaxRate',
    validator: {
      validate: (value: unknown) => isValidTaxRate(value),
      defaultMessage: (args?: { property?: string }) => `${args?.property ?? 'value'} must be a percent from 0 to 100 with at most 2 decimals`,
    },
  });
}
