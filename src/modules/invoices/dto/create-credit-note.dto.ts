import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { IsMoney } from '../../../common/money/money-validation';

/** A credit note (avoir): why, and how much (the whole of what is left on the invoice when no amount is sent). */
export class CreateCreditNoteDto {
  /** Printed on the credit note: the customer reads it. */
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;

  /** The amount taken back, with VAT. Left out: all that is left on the invoice. */
  @IsOptional()
  @IsMoney()
  amountTTC?: number;
}
