import { Type } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

import { InvoiceStatus, PaymentMethod, PaymentStatus } from '../../../../generated/prisma/client';
import { INVOICE_VIEWS, PAYMENT_SORTS, PAYMENT_VIEWS } from '../finance-queries';

/** A calendar day of the business clock: 2026-10-19. The period is read by `periodOf`, which also refuses a day that does not exist. */
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_WORDS = 'La date doit s’écrire AAAA-MM-JJ.';

/** The period of a screen: from the first day to the last day, both included, on the clock of the business. */
export class FinancePeriodQueryDto {
  @IsOptional()
  @IsString()
  @Matches(DAY, { message: DAY_WORDS })
  from?: string;

  @IsOptional()
  @IsString()
  @Matches(DAY, { message: DAY_WORDS })
  to?: string;
}

/** A page of a list, 20 rows by default and at most 100. */
export class FinancePageQueryDto extends FinancePeriodQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  /** A job number, a payment number, a reference, a receipt or invoice number, a customer's name or phone (cut at 100 characters). */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}

export class FinancePaymentsQueryDto extends FinancePageQueryDto {
  /** awaiting: waits for the team; received: money in, in the period it was confirmed; refunded: money given back; all (the default). */
  @IsOptional()
  @IsIn(PAYMENT_VIEWS)
  view?: string;

  @IsOptional()
  @IsEnum(PaymentStatus)
  status?: PaymentStatus;

  @IsOptional()
  @IsEnum(PaymentMethod)
  method?: PaymentMethod;

  /** Only the payments of this job (the complaint screen links to them): the number of the job, not a text to search for. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  interventionId?: number;

  /** newest or oldest: by the date the view is about (the one waiting longest first is `oldest`). */
  @IsOptional()
  @IsIn(PAYMENT_SORTS)
  sort?: string;
}

export class FinanceInvoicesQueryDto extends FinancePageQueryDto {
  /** unpaid: out and not paid; credited: has credit notes; all (the default). */
  @IsOptional()
  @IsIn(INVOICE_VIEWS)
  view?: string;

  @IsOptional()
  @IsEnum(InvoiceStatus)
  status?: InvoiceStatus;
}

/** The export takes the filters of the list and none of its paging. */
export class FinancePaymentsExportQueryDto extends FinancePeriodQueryDto {
  @IsOptional()
  @IsIn(PAYMENT_VIEWS)
  view?: string;

  @IsOptional()
  @IsEnum(PaymentStatus)
  status?: PaymentStatus;

  @IsOptional()
  @IsEnum(PaymentMethod)
  method?: PaymentMethod;

  /** Only the payments of this job (the complaint screen links to them): the number of the job, not a text to search for. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  interventionId?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}
