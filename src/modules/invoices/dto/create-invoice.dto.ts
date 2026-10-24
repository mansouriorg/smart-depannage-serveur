import {
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { IsMoney, IsTaxRate } from '../../../common/money/money-validation';

/**
 * What the back office sends to make an invoice (P2-07). The number is not sent: it is taken in order from the counter. Nor is a
 * link to a PDF: the PDF is drawn from the invoice.
 */
export class CreateInvoiceDto {
  @IsOptional()
  @IsMoney()
  amountHT?: number;

  @IsOptional()
  @IsTaxRate()
  taxRate?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

/** POST /invoices/generate: the same, with the job it is made for (a class, so that the checks above run on the body). */
export class GenerateInvoiceDto extends CreateInvoiceDto {
  @IsInt()
  @Min(1)
  interventionId!: number;
}
