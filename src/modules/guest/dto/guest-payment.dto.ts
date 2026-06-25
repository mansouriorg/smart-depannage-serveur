import { IsEnum, IsOptional, IsString } from 'class-validator';
import { PaymentMethod } from '../../../../generated/prisma/client';

export class GuestPaymentDto {
  @IsEnum(PaymentMethod)
  method: PaymentMethod;

  @IsOptional()
  @IsString()
  reference?: string;

  @IsOptional()
  @IsString()
  clientNote?: string;
}