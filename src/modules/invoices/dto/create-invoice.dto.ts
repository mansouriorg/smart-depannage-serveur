import {
  IsOptional,
  IsString,
} from 'class-validator';
import { IsMoney, IsTaxRate } from '../../../common/money/money-validation';

export class CreateInvoiceDto {
  @IsOptional()
  @IsString()
  invoiceNumber?: string;

  @IsOptional()
  @IsMoney()
  amountHT?: number;

  @IsOptional()
  @IsTaxRate()
  taxRate?: number;

  @IsOptional()
  @IsString()
  pdfUrl?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
