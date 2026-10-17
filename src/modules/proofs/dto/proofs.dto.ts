import { IsIn, IsInt, IsOptional, IsString, MaxLength, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * What the phone sends next to the photo (multipart: every value is text). The values are read by
 * proof-input.ts, which never throws; here they are only declared, so the global validation
 * (which refuses unknown fields) lets them through.
 */
export class AddProofDto {
  @IsOptional()
  latitude?: unknown;

  @IsOptional()
  longitude?: unknown;

  /** The radius of the position, in metres. */
  @IsOptional()
  accuracy?: unknown;

  /** Whether the phone says the position was simulated. */
  @IsOptional()
  mocked?: unknown;

  /** When the phone says the photo was taken. */
  @IsOptional()
  capturedAt?: unknown;

  /** The older name of capturedAt, which the app of today sends. */
  @IsOptional()
  timestamp?: unknown;
}

export class ListProofsDto {
  @IsOptional()
  @IsIn(['ACCEPTED', 'NEEDS_REVIEW', 'REJECTED'])
  status?: string;

  @IsOptional()
  @IsIn(['BEFORE', 'AFTER'])
  kind?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  interventionId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  take?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  skip?: number;
}

export class ReviewProofDto {
  @IsIn(['APPROVE', 'REJECT'])
  decision!: 'APPROVE' | 'REJECT';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
