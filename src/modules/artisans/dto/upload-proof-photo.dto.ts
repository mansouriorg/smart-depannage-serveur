import { IsDateString, IsNumber, IsOptional, IsString } from 'class-validator';

export class UploadProofPhotoDto {
  @IsString()
  photoUrl: string;

  @IsNumber()
  latitude: number;

  @IsNumber()
  longitude: number;

  @IsOptional()
  @IsDateString()
  timestamp?: string;
}