import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
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

export class ConfirmPaymentDto {
  @IsOptional()
  @IsString()
  reference?: string;

  @IsOptional()
  @IsString()
  adminNote?: string;
}

export class FailPaymentDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

export class CancelPaymentDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

export class RefundPaymentDto {
  @IsOptional()
  @IsMoney({ min: 0.001 })
  amount?: number;

  @IsOptional()
  @IsString()
  reason?: string;
}

export class LinkPaymentToInvoiceDto {
  @IsNumber()
  invoiceId: number;
}

export class SetReceiptUrlDto {
  @IsString()
  receiptUrl: string;
}
