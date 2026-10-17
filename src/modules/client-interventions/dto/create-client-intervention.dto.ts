
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ServiceType, UrgencyLevel } from '../../../../generated/prisma/client';

export class CreateClientInterventionDto {
  @IsEnum(ServiceType)
  serviceType: ServiceType;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2147483647)
  subServiceId?: number;

  @IsString()
  @MaxLength(2000)
  description: string;

  @IsOptional()
  @IsEnum(UrgencyLevel)
  urgency?: UrgencyLevel;

  @IsString()
  @MaxLength(300)
  address: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2147483647)
  savedAddressId?: number;

  @IsOptional()
  @IsNumber()
  latitude?: number;

  @IsOptional()
  @IsNumber()
  longitude?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @IsString({ each: true })
  @MaxLength(300, { each: true })
  photos?: string[];

  @IsOptional()
  @IsDateString()
  preferredDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  preferredStartTime?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  preferredEndTime?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  contactName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  contactPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  accessInstructions?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  buildingInfo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  floor?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  apartmentCode?: string;
}
