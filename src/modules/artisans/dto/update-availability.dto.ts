import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { SLOT_END_REGEX, SLOT_START_REGEX } from './slot-time';
import {
  ArtisanAvailabilityStatus,
  DayOfWeek,
} from '../../../../generated/prisma/client';

export class AvailabilitySlotDto {
  @IsEnum(DayOfWeek)
  dayOfWeek: DayOfWeek;

  @IsString()
  @Matches(SLOT_START_REGEX, { message: 'startTime doit être au format HH:mm (par exemple 08:00).' })
  startTime: string;

  @IsString()
  @Matches(SLOT_END_REGEX, { message: 'endTime doit être au format HH:mm (par exemple 17:00, ou 24:00 pour minuit).' })
  endTime: string;

  @IsOptional()
  @IsBoolean()
  isAvailable?: boolean;
}

export class UpdateAvailabilityDto {
  @IsOptional()
  @IsEnum(ArtisanAvailabilityStatus)
  availabilityStatus?: ArtisanAvailabilityStatus;

  @IsOptional()
  @IsBoolean()
  isAcceptingJobs?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AvailabilitySlotDto)
  slots?: AvailabilitySlotDto[];
}
