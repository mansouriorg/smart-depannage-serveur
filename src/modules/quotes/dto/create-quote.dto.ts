import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { IsMoney, IsTaxRate } from '../../../common/money/money-validation';

export class CreateQuoteItemDto {
  @IsString()
  label: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsNumber()
  quantity: number;

  @IsMoney()
  unitPrice: number;
}

export class CreateQuoteDto {
  @IsString()
  title: string;

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

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateQuoteItemDto)
  items: CreateQuoteItemDto[];
}
