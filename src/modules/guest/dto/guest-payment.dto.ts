import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaymentMethod } from '../../../../generated/prisma/client';

export class GuestPaymentDto {
  @IsEnum(PaymentMethod)
  method: PaymentMethod;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  reference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  clientNote?: string;
}
