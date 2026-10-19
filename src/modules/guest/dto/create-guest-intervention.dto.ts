import {
  IsDateString,
  IsEmail,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import {
  ServiceType,
  UrgencyLevel,
} from '../../../../generated/prisma/client';
import { BotCheckFields } from '../../../common/bot-check/bot-check.dto';

/**
 * Everything here comes from somebody with no account, so every text has a
 * ceiling (P1-04): nobody can store megabytes in a request, or push a very long
 * text into the messages and notifications that repeat it.
 *
 * There is no `photos` field: a link written by the visitor would be shown to
 * staff as if it were a photo. Pictures are uploaded once the request exists
 * (POST /guest/interventions/:id/photos?token=).
 *
 * The form also carries the three fields of the bot check (BotCheckFields, P1-16).
 */
export class CreateGuestInterventionDto extends BotCheckFields {
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
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude?: number;

  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude?: number;

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

  @IsString()
  @MaxLength(30)
  contactPhone: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  contactEmail?: string;

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
