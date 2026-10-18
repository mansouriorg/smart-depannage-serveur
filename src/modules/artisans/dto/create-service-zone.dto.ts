import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * A zone an artisan adds to their own profile (P1-11): either one picked from the platform's list
 * (`zoneId`, from GET /service-zones: the centre and the radius are the platform's), or a circle
 * of their own with a centre (`latitude` and `longitude`). A zone with only a name can be neither
 * drawn nor checked against a job, so it is no longer taken.
 */
export class CreateServiceZoneDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  zoneId?: number;

  @IsOptional()
  @IsString()
  label?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  postalCode?: string;

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
  @IsNumber()
  @Min(1)
  @Max(200)
  radiusKm?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
