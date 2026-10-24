import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class ClientQuoteActionDto {
  @IsOptional()
  @IsString()
  note?: string;

  /** The revision of the quote the customer read (the `revision` of the quote). If the quote was edited since, the answer is refused. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  revision?: number;
}
