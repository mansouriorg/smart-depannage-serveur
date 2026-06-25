import {
  IsInt,
  IsNumber,
  IsOptional,
  Min,
  Max,
} from 'class-validator';

import { Type } from 'class-transformer';

export class JoinInterventionRoomDto {
  @Type(() => Number)
  @IsInt()
  interventionId: number;
}

export class LeaveInterventionRoomDto {
  @Type(() => Number)
  @IsInt()
  interventionId: number;
}

export class ArtisanLocationUpdateDto {
  @Type(() => Number)
  @IsInt()
  interventionId: number;

  @Type(() => Number)
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude: number;

  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  accuracy?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  heading?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  speed?: number;
}