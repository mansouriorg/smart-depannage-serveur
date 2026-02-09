import { PartialType } from '@nestjs/mapped-types';
import { CreateInterventionDto } from './create-intervention.dto';
import { IsEnum, IsOptional } from 'class-validator';

// ✅ NEW: Import 'Status' from your custom generated location
// Adjust the number of '../' if your folder structure is different
import { Status } from '../../../../generated/prisma/client';

export class UpdateInterventionDto extends PartialType(CreateInterventionDto) {
  // We add Status here because usually, you don't set status when CREATING, 
  // but you do when UPDATING (e.g., Artisan changes PENDING to ACCEPTED).
  @IsOptional()
  @IsEnum(Status)
  status?: Status;
}