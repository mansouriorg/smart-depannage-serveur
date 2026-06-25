import {
  IsArray,
  IsDateString,
  IsEmail,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';

import {
  ServiceType,
  UrgencyLevel,
} from '../../../../generated/prisma/client';

export class CreateGuestInterventionDto {
  @IsEnum(ServiceType)
  serviceType: ServiceType;

  @IsOptional()
  @IsNumber()
  subServiceId?: number;

  @IsString()
  description: string;

  @IsOptional()
  @IsEnum(UrgencyLevel)
  urgency?: UrgencyLevel;

  @IsString()
  address: string;

  @IsOptional()
  @IsNumber()
  latitude?: number;

  @IsOptional()
  @IsNumber()
  longitude?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  photos?: string[];

  @IsOptional()
  @IsDateString()
  preferredDate?: string;

  @IsOptional()
  @IsString()
  preferredStartTime?: string;

  @IsOptional()
  @IsString()
  preferredEndTime?: string;

  @IsOptional()
  @IsString()
  contactName?: string;

  @IsString()
  contactPhone: string;

  @IsOptional()
  @IsEmail()
  contactEmail?: string;

  @IsOptional()
  @IsString()
  accessInstructions?: string;

  @IsOptional()
  @IsString()
  buildingInfo?: string;

  @IsOptional()
  @IsString()
  floor?: string;

  @IsOptional()
  @IsString()
  apartmentCode?: string;
}