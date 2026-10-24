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

import { QuoteStatus } from '../../../../generated/prisma/client';

// ==========================================================
// LINE ITEMS
// ==========================================================

export class QuoteItemDto {
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

// ==========================================================
// CREATE / UPDATE QUOTE
// ==========================================================

export class CreateQuoteDto {
  @IsNumber()
  interventionId: number;

  @IsString()
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsTaxRate()
  taxRate?: number;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => QuoteItemDto)
  items: QuoteItemDto[];
}

export class UpdateQuoteDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsTaxRate()
  taxRate?: number;

  @IsOptional()
  @IsString()
  pdfUrl?: string;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => QuoteItemDto)
  items?: QuoteItemDto[];
}

// ==========================================================
// QUOTE ACTIONS
// ==========================================================

export class SendQuoteDto {
  @IsOptional()
  @IsString()
  message?: string;
}

export class RejectQuoteDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

export class CancelQuoteDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

export class AskQuoteQuestionDto {
  @IsString()
  question: string;
}

export class SetQuotePdfDto {
  @IsString()
  pdfUrl: string;
}

export class QuoteQueryDto {
  @IsOptional()
  @IsEnum(QuoteStatus)
  status?: QuoteStatus;

  @IsOptional()
  @IsString()
  interventionId?: string;
}
