import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class GuestQuoteActionDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  /** The revision of the quote the visitor read (the `revision` of the quote). If the quote was edited since, the answer is refused. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  revision?: number;
}
