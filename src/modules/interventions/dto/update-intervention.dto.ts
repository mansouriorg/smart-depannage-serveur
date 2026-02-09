import { PartialType } from '@nestjs/mapped-types';
import { CreateInterventionDto } from './create-intervention.dto';
import { IsEnum, IsNumber, IsOptional } from 'class-validator';

// ✅ Import 'Status' from your custom generated location
// Adjust the number of '../' if your folder structure is different
import { Status } from '../../../../generated/prisma/client'; 

export class UpdateInterventionDto extends PartialType(CreateInterventionDto) {
  // 1. Status Update (e.g., PENDING -> ACCEPTED -> COMPLETED)
  @IsOptional()
  @IsEnum(Status)
  status?: Status;

  // 2. Technician Assignment (New!)
  // Sending { "artisanId": 5 } will assign the ticket to Artisan #5
  @IsOptional()
  @IsNumber()
  artisanId?: number;
}