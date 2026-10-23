import { IsInt, IsOptional, IsString, Length, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';

import { MAX_COLUMN_AMOUNT } from '../../../common/money/money';
import { IsMoney } from '../../../common/money/money-validation';

/** The artisan says how much cash they took from the customer of a job. */
export class CollectCashDto {
  @Type(() => Number)
  @IsMoney({ min: 0.001 })
  amount: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  /**
   * The app's own key for this tap (a random text): sending the request twice writes it once. Required: a cash collection
   * writes money, and a request that is sent again after a lost answer must not write it a second time.
   */
  @IsString()
  @Length(8, 64)
  requestKey: string;
}

/** The back office records commission that an artisan has paid to the platform. */
export class RecordRemittanceDto {
  @Type(() => Number)
  @IsMoney({ min: 0.001 })
  amount: number;

  /** The number of the transfer or of the receipt. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsOptional()
  @IsString()
  @Length(8, 64)
  requestKey?: string;
}

/**
 * The back office puts a figure right: a refund the artisan bore, a collection that was typed wrong, the balance an artisan
 * had before the ledger existed. The amounts are signed (a minus takes off), and the reason is kept with the line.
 */
export class RecordAdjustmentDto {
  @IsOptional()
  @Type(() => Number)
  @IsMoney({ min: -MAX_COLUMN_AMOUNT })
  commissionAmount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsMoney({ min: -MAX_COLUMN_AMOUNT })
  cashAmount?: number;

  @IsString()
  @Length(3, 500)
  reason: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  interventionId?: number;

  @IsOptional()
  @IsString()
  @Length(8, 64)
  requestKey?: string;
}

/** The lines of a ledger, newest first, a page at a time. */
export class LedgerQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  /** The id of the last line of the previous page. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  before?: number;
}
