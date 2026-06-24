import { IsEnum, IsOptional, IsString } from 'class-validator';
import { ComplaintStatus } from '../../../../generated/prisma/client';

export class UpdateComplaintStatusDto {
  @IsEnum(ComplaintStatus)
  status: ComplaintStatus;

  @IsOptional()
  @IsString()
  adminNotes?: string;
}