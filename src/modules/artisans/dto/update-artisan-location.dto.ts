import { IsBoolean, IsEnum, IsNumber, IsOptional } from 'class-validator';
import { ArtisanAvailabilityStatus } from '../../../../generated/prisma/client';

export class UpdateArtisanLocationDto {
  @IsNumber()
  latitude: number;

  @IsNumber()
  longitude: number;

  /** What the phone says about the reading (P3-05): the radius of doubt in metres, the speed in metres per second, the heading in degrees. */
  @IsOptional()
  @IsNumber()
  accuracy?: number;

  @IsOptional()
  @IsNumber()
  speed?: number;

  @IsOptional()
  @IsNumber()
  heading?: number;

  @IsOptional()
  @IsEnum(ArtisanAvailabilityStatus)
  availabilityStatus?: ArtisanAvailabilityStatus;

  @IsOptional()
  @IsBoolean()
  isAcceptingJobs?: boolean;
}
