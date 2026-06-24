import { IsOptional, IsString } from 'class-validator';

export class AdminPaymentActionDto {
  @IsOptional()
  @IsString()
  adminNote?: string;
}