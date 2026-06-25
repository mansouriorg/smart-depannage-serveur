import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  ArtisanAvailabilityStatus,
  DayOfWeek,
} from '../../../../generated/prisma/client';

export class AvailabilitySlotDto {
  @IsEnum(DayOfWeek)
  dayOfWeek: DayOfWeek;

  @IsString()
  startTime: string;

  @IsString()
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