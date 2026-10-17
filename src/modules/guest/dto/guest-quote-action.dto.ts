import { IsOptional, IsString, MaxLength } from 'class-validator';

export class GuestQuoteActionDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
