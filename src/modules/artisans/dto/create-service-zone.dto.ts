import { IsBoolean, IsNumber, IsOptional, IsString } from 'class-validator';

export class CreateServiceZoneDto {
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
  latitude?: number;

  @IsOptional()
  @IsNumber()
  longitude?: number;

  @IsOptional()
  @IsNumber()
  radiusKm?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}