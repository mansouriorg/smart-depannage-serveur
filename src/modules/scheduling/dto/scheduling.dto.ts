import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

import { Type } from 'class-transformer';

import {
  ArtisanTimeBlockType,
  DayOfWeek,
} from '../../../../generated/prisma/client';

const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

export class PreferredTimeDto {
  @IsDateString()
  preferredDate: string;

  @Matches(TIME_REGEX)
  preferredStartTime: string;

  @Matches(TIME_REGEX)
  preferredEndTime: string;

  @IsOptional()
  @IsString()
  clientNote?: string;
}

export class ScheduleInterventionDto {
  @Type(() => Number)
  @IsInt()
  artisanId: number;

  @IsDateString()
  startsAt: string;

  @IsDateString()
  endsAt: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  adminNote?: string;
}

export class RescheduleRequestDto {
  @IsDateString()
  requestedStartAt: string;

  @IsDateString()
  requestedEndAt: string;

  @IsOptional()
  @IsString()
  reason?: string;
}

export class CancelAppointmentRequestDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

export class ReviewAppointmentRequestDto {
  @IsOptional()
  @IsString()
  adminResponse?: string;
}

export class UpdateAvailabilitySlotDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  slotId?: number;

  @IsEnum(DayOfWeek)
  dayOfWeek: DayOfWeek;

  @Matches(TIME_REGEX)
  startTime: string;

  @Matches(TIME_REGEX)
  endTime: string;

  @IsOptional()
  isAvailable?: boolean;
}

export class CreateTimeBlockDto {
  @IsDateString()
  startsAt: string;

  @IsDateString()
  endsAt: string;

  @IsOptional()
  @IsEnum(ArtisanTimeBlockType)
  type?: ArtisanTimeBlockType;

  @IsOptional()
  @IsString()
  reason?: string;
}

export class CalendarQueryDto {
  @IsDateString()
  from: string;

  @IsDateString()
  to: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  artisanId?: number;
}
