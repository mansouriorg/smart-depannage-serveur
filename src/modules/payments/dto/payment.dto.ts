import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { IsMoney } from '../../../common/money/money-validation';

import {
  PaymentMethod,
  PaymentProvider,
} from '../../../../generated/prisma/client';

export class CreatePaymentDto {
  @IsNumber()
  interventionId: number;

  @IsOptional()
  @IsNumber()
  quoteId?: number;

  @IsOptional()
  @IsNumber()
  invoiceId?: number;

  @IsEnum(PaymentMethod)
  method: PaymentMethod;

  @IsOptional()
  @IsEnum(PaymentProvider)
  provider?: PaymentProvider;

  @IsOptional()
  @IsMoney({ min: 0.001 })
  amount?: number;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsString()
  reference?: string;

  @IsOptional()
  @IsString()
  clientNote?: string;

  @IsOptional()
  @IsString()
  adminNote?: string;
}

/** PATCH /payments/:id/confirm */
export class ConfirmPaymentDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reference?: string;

  @IsOptional()
  @IsString()
  adminNote?: string;
}

/** PATCH /payments/:id/fail: the reason is kept on the payment (for the back office only). */
export class FailPaymentDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @IsOptional()
  @IsString()
  adminNote?: string;
}

/** PATCH /payments/:id/cancel: the reason is kept on the payment (for the back office only). */
export class CancelPaymentDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @IsOptional()
  @IsString()
  adminNote?: string;
}

/** PATCH /payments/:id/refund: no amount refunds what is left of the payment. */
export class RefundPaymentDto {
  @IsOptional()
  @IsMoney({ min: 0.001 })
  amount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @IsOptional()
  @IsString()
  adminNote?: string;
}

export class LinkPaymentToInvoiceDto {
  @IsNumber()
  invoiceId: number;
}

export class SetReceiptUrlDto {
  @IsString()
  receiptUrl: string;
}
