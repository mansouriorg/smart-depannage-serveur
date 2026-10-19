import { OmitType, PartialType } from '@nestjs/mapped-types';
import { CreateInterventionDto } from './create-intervention.dto';
import { IsEnum, IsNumber, IsOptional } from 'class-validator';

// ✅ Import 'Status' from your custom generated location
import { Status } from '../../../../generated/prisma/client'; 

// The bot check fields belong to the anonymous create only (P1-16): a staff update with one of them would be passed on to the
// database as a column that does not exist, so they are not accepted here (the whitelist answers 400, as it did before).
export class UpdateInterventionDto extends PartialType(
  OmitType(CreateInterventionDto, ['botChallenge', 'botSolution', 'website'] as const),
) {
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
