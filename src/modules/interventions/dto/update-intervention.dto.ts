import { PartialType } from '@nestjs/mapped-types';
import { CreateInterventionDto } from './create-intervention.dto';
import { IsEnum, IsOptional } from 'class-validator';
import { Status } from '@prisma/client';

export class UpdateInterventionDto extends PartialType(CreateInterventionDto) {
  // We add Status here because usually, you don't set status when CREATING, 
  // but you do when UPDATING (e.g., Artisan changes PENDING to ACCEPTED).
  @IsOptional()
  @IsEnum(Status)
  status?: Status;
}