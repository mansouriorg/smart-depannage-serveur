import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { IsMoney } from '../../../common/money/money-validation';

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
  @IsMoney()
  basePrice?: number;

  @IsOptional()
  @IsMoney()
  emergencyPrice?: number;

  @IsOptional()
  @IsBoolean()
  requiresPhotos?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
