import { IsEnum, IsOptional, IsString } from 'class-validator';
import { MissionProblemType } from '../../../../generated/prisma/client';

export class ReportProblemDto {
  @IsEnum(MissionProblemType)
  problemType: MissionProblemType;

  @IsOptional()
  @IsString()
  notes?: string;
}