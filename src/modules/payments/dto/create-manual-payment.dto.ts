import {
  IsEnum,
  IsOptional,
  IsString,
} from 'class-validator';
import { IsMoney } from '../../../common/money/money-validation';
import { PaymentMethod } from '../../../../generated/prisma/client';

export class CreateManualPaymentDto {
  @IsEnum(PaymentMethod)
  method: PaymentMethod;

  @IsOptional()
  @IsMoney()
  amount?: number;

  @IsOptional()
  @IsString()
  reference?: string;

  @IsOptional()
  @IsString()
  clientNote?: string;
}
