import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { IsMoney } from '../../../common/money/money-validation';

export class UpdateSubServiceDto {
  @IsOptional()
  @IsInt()
  categoryId?: number;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  /**
   * Estimated duration in minutes.
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
