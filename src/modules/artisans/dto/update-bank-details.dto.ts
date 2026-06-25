import { IsOptional, IsString } from 'class-validator';

export class UpdateBankDetailsDto {
  @IsOptional()
  @IsString()
  accountHolderName?: string;

  @IsOptional()
  @IsString()
  bankName?: string;

  @IsOptional()
  @IsString()
  iban?: string;

  @IsOptional()
  @IsString()
  bic?: string;
}