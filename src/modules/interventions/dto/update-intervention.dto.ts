import { PartialType } from '@nestjs/mapped-types';
import { CreateInterventionDto } from './create-intervention.dto';
import { IsEnum, IsNumber, IsOptional, IsString, IsDateString } from 'class-validator';

// ✅ Import 'Status' from your custom generated location
import { Status } from '../../../../generated/prisma/client'; 

export class UpdateInterventionDto extends PartialType(CreateInterventionDto) {
  // 1. Status Update (e.g., PENDING -> ACCEPTED -> IN_PROGRESS -> COMPLETED)
  @IsOptional()
  @IsEnum(Status)
  status?: Status;

  // 2. Technician Assignment 
  @IsOptional()
  @IsNumber()
  artisanId?: number;

  // ==========================================================
  // 📸 NEW: Tamper-Proof "Before" Photo Data (Artisan Upload)
  // ==========================================================
  @IsOptional()
  @IsString()
  beforePhotoUrl?: string;

  @IsOptional()
  @IsNumber()
  beforePhotoLat?: number;

  @IsOptional()
  @IsNumber()
  beforePhotoLng?: number;

  @IsOptional()
  @IsDateString()
  beforePhotoAt?: string | Date;

  // ==========================================================
  // 📸 NEW: Tamper-Proof "After" Photo Data (Artisan Upload)
  // ==========================================================
  @IsOptional()
  @IsString()
  afterPhotoUrl?: string;

  @IsOptional()
  @IsNumber()
  afterPhotoLat?: number;

  @IsOptional()
  @IsNumber()
  afterPhotoLng?: number;

  @IsOptional()
  @IsDateString()
  afterPhotoAt?: string | Date;
}