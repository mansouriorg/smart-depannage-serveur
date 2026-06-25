import {
  IsArray,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class ApplyArtisanDto {
  @IsString()
  name: string;

  @IsEmail()
  email: string;

  @IsString()
  phone: string;

  @IsOptional()
  @IsString()
  companyName?: string;

  @IsOptional()
  @IsString()
  companyNumber?: string;

  @IsOptional()
  @IsString()
  insuranceNumber?: string;

  @IsOptional()
  @IsString()
  specialty?: string;

  @IsArray()
  @IsString({ each: true })
  specialties: string[];

  @IsInt()
  @Min(0)
  yearsExperience: number;

  @IsOptional()
  @IsString()
  bio?: string;

  @IsOptional()
  @IsString()
  profilePhotoUrl?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  serviceAreas?: string[];

  @IsOptional()
  @IsString()
  identityDocumentUrl?: string;

  @IsOptional()
  @IsString()
  companyDocumentUrl?: string;

  @IsOptional()
  @IsString()
  insuranceCertificateUrl?: string;
}