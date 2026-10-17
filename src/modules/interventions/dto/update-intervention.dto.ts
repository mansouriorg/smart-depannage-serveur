import { PartialType } from '@nestjs/mapped-types';
import { CreateInterventionDto } from './create-intervention.dto';
import { IsEnum, IsNumber, IsOptional } from 'class-validator';

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

  // The before/after photo columns are not here on purpose (P1-07): they are written by the
  // proof service, from a photo it has judged, and by nothing else. POST /interventions/:id/proofs/:kind.
}
