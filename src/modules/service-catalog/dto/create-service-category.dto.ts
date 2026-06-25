import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
} from 'class-validator';

import { ServiceType } from '../../../../generated/prisma/client';

export class CreateServiceCategoryDto {
  @IsEnum(ServiceType)
  serviceType: ServiceType;

  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}