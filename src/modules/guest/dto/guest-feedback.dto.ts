import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class GuestFeedbackDto {
  @IsInt()
  @Min(1)
  @Max(5)
  rating: number;

  @IsOptional()
  @IsBoolean()
  isOnTime?: boolean;

  @IsOptional()
  @IsBoolean()
  hasIssue?: boolean;

  @IsOptional()
  @IsString()
  feedbackNotes?: string;
}