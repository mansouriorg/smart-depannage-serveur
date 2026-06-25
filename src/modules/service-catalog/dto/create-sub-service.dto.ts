import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class CreateSubServiceDto {
  @IsInt()
  categoryId: number;

  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  /**
   * Estimated duration in minutes.
   * Example: 60 = 1 hour
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  estimatedDuration?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  basePrice?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  emergencyPrice?: number;

  @IsOptional()
  @IsBoolean()
  requiresPhotos?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}