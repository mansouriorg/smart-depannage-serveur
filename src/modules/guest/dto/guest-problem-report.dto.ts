import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

const trimmed = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * A problem reported from the tracking link by somebody with no account
 * (POST /guest/interventions/:id/problems). It opens a complaint, so both texts
 * have a ceiling: the same text is shown in the staff's notifications and in the
 * complaint thread.
 */
export class GuestProblemReportDto {
  /** Short title shown in the complaint list; the first words of the text when left out. */
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(120)
  title?: string;

  @Transform(trimmed)
  @IsString()
  @MinLength(5)
  @MaxLength(1000)
  description: string;
}
