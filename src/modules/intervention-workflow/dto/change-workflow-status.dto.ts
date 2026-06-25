import { IsEnum, IsOptional, IsString } from 'class-validator';

import { Status } from '../../../../generated/prisma/client';

export class ChangeWorkflowStatusDto {
  @IsEnum(Status)
  status: Status;

  @IsOptional()
  @IsString()
  note?: string;
}