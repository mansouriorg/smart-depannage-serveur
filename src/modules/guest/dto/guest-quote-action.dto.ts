import { IsOptional, IsString } from 'class-validator';

export class GuestQuoteActionDto {
  @IsOptional()
  @IsString()
  note?: string;
}