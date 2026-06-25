import { IsEnum, IsOptional, IsString } from 'class-validator';
import { MissionRejectionReason } from '../../../../generated/prisma/client';

export class RejectMissionDto {
  @IsEnum(MissionRejectionReason)
  reason: MissionRejectionReason;

  @IsOptional()
  @IsString()
  note?: string;
}