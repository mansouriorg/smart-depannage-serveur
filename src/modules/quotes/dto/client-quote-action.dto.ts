import { IsOptional, IsString } from 'class-validator';

export class ClientQuoteActionDto {
  @IsOptional()
  @IsString()
  note?: string;
}