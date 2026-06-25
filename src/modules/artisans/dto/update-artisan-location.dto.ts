import { IsBoolean, IsEnum, IsNumber, IsOptional } from 'class-validator';
import { ArtisanAvailabilityStatus } from '../../../../generated/prisma/client';

export class UpdateArtisanLocationDto {
  @IsNumber()
  latitude: number;

  @IsNumber()
  longitude: number;

  @IsOptional()
  @IsEnum(ArtisanAvailabilityStatus)
  availabilityStatus?: ArtisanAvailabilityStatus;

  @IsOptional()
  @IsBoolean()
  isAcceptingJobs?: boolean;
}