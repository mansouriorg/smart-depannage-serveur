import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { IsMoney } from '../../../common/money/money-validation';

import {
  InvoiceStatus,
  PaymentStatus,
} from '../../../../generated/prisma/client';

export class InvoiceLineDto {
  @IsString()
  label: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsNumber()
  @Min(0.01)
  quantity: number;

  @IsMoney()
  unitPrice: number;
}

export class SendInvoiceEmailDto {
  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  message?: string;
}

export class CancelInvoiceDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

export class ExportInvoicesQueryDto {
  @IsOptional()
  @IsEnum(InvoiceStatus)
  status?: InvoiceStatus;

  @IsOptional()
  @IsEnum(PaymentStatus)
  paymentStatus?: PaymentStatus;

  @IsOptional()
  @IsString()
  dateFrom?: string;

  @IsOptional()
  @IsString()
  dateTo?: string;

  @IsOptional()
  @IsString()
  format?: 'json' | 'csv';
}
