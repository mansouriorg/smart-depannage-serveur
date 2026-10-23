import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { IsMoney, IsTaxRate } from '../../../common/money/money-validation';

import { Type } from 'class-transformer';

import {
  BusinessExportFormat,
} from '../../../../generated/prisma/client';

export class CalculateInterventionFinancialsDto {
  @Type(() => Number)
  @IsMoney()
  totalPrice: number;

  @IsOptional()
  @Type(() => Number)
  @IsTaxRate()
  commissionRate?: number;

  @IsOptional()
  @Type(() => Number)
  @IsMoney()
  artisanPayout?: number;

  @IsOptional()
  @Type(() => Number)
  @IsMoney()
  paymentProviderFee?: number;

  @IsOptional()
  @Type(() => Number)
  @IsMoney()
  refundAmount?: number;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class BusinessDateRangeQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  artisanId?: number;
}

export class CreateMonthlyReportDto {
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  year: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  month: number;
}

export class CreatePayoutDto {
  @Type(() => Number)
  @IsInt()
  artisanId: number;

  @IsDateString()
  periodStart: string;

  @IsDateString()
  periodEnd: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class MarkPayoutPaidDto {
  @IsOptional()
  @IsString()
  paymentReference?: string;

  @IsOptional()
  @IsDateString()
  paidAt?: string;
}

export class ExportQueryDto {
  @IsDateString()
  from: string;

  @IsDateString()
  to: string;

  @IsOptional()
  @IsEnum(BusinessExportFormat)
  format?: BusinessExportFormat;
}
