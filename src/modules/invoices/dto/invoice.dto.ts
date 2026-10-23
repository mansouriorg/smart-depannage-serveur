import {
  IsArray,
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { IsMoney, IsTaxRate } from '../../../common/money/money-validation';

import { Type } from 'class-transformer';

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

export class GenerateInvoiceDto {
  @IsNumber()
  interventionId: number;

  @IsOptional()
  @IsNumber()
  quoteId?: number;

  @IsOptional()
  @IsTaxRate()
  taxRate?: number;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsDateString()
  issuedAt?: string;

  @IsOptional()
  @IsString()
  pdfUrl?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InvoiceLineDto)
  items?: InvoiceLineDto[];
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

export class SetInvoicePdfDto {
  @IsString()
  pdfUrl: string;
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
