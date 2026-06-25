import { IsString } from 'class-validator';

export class RequestExtraQuoteDto {
  @IsString()
  reason: string;
}