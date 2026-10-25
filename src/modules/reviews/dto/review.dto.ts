import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsIn,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { Transform, Type } from 'class-transformer';

import {
  ReviewModerationStatus,
} from '../../../../generated/prisma/client';

function toBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (value === true || value === 'true' || value === '1') {
    return true;
  }

  if (value === false || value === 'false' || value === '0') {
    return false;
  }

  return undefined;
}

export class CreateReviewDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  rating: number;

  @IsOptional()
  @IsString()
  comment?: string;

  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  isOnTime?: boolean;

  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  isWorkClean?: boolean;

  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  isPriceRespected?: boolean;

  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  wouldRecommend?: boolean;
}

export class ModerateReviewDto {
  @IsEnum(ReviewModerationStatus)
  status: ReviewModerationStatus;

  /** Required to refuse or hide a review (the service says so); the longest is MODERATION_REASON_MAX. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  moderationReason?: string;
}

export class ReviewQueryDto {
  @IsOptional()
  @IsEnum(ReviewModerationStatus)
  status?: ReviewModerationStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  artisanId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  clientId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  interventionId?: number;

  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  onlyVisible?: boolean;

  /** The best rating that is shown: 2 asks for the 1- and 2-star reviews (P2-09). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  maxRating?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @IsOptional()
  @IsIn(['oldest', 'newest'])
  sort?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  skip?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  take?: number;
}
