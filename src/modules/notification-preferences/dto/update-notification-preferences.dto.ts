import { IsBoolean, IsOptional } from 'class-validator';

export class UpdateNotificationPreferencesDto {
  @IsOptional()
  @IsBoolean()
  emailEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  smsEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  pushEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  interventionUpdates?: boolean;

  @IsOptional()
  @IsBoolean()
  quoteUpdates?: boolean;

  @IsOptional()
  @IsBoolean()
  paymentUpdates?: boolean;

  @IsOptional()
  @IsBoolean()
  invoiceUpdates?: boolean;

  @IsOptional()
  @IsBoolean()
  complaintUpdates?: boolean;

  @IsOptional()
  @IsBoolean()
  marketingUpdates?: boolean;
}