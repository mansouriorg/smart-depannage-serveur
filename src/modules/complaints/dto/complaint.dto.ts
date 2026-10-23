import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
} from 'class-validator';
import { IsMoney } from '../../../common/money/money-validation';

import { Transform, Type } from 'class-transformer';

import {
  ComplaintDecision,
  ComplaintRefundDecision,
  ComplaintStatus,
} from '../../../../generated/prisma/client';

function toBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (value === true || value === 'true' || value === '1') {
    return true;
  }

  if (value === false || value === 'false' || value === '0') {
    return false;
  }

  return undefined;
}

export class CreateComplaintDto {
  @IsString()
  title: string;

  @IsString()
  description: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  photos?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  attachments?: string[];

  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  refundRequested?: boolean;
}

export class AddComplaintMessageDto {
  @IsString()
  content: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  attachments?: string[];

  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  isInternal?: boolean;
}

export class ArtisanResponseDto {
  @IsString()
  response: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  attachments?: string[];
}

export class AssignComplaintDto {
  @Type(() => Number)
  @IsInt()
  assignedToId: number;
}

export class UpdateComplaintStatusDto {
  @IsEnum(ComplaintStatus)
  status: ComplaintStatus;

  @IsOptional()
  @IsString()
  note?: string;
}

export class AdminComplaintDecisionDto {
  @IsEnum(ComplaintDecision)
  decision: ComplaintDecision;

  @IsOptional()
  @IsString()
  note?: string;
}

export class RefundDecisionDto {
  @IsEnum(ComplaintRefundDecision)
  decision: ComplaintRefundDecision;

  @IsOptional()
  @Type(() => Number)
  @IsMoney()
  refundAmount?: number;

  @IsOptional()
  @IsString()
  note?: string;
}

export class ResolveComplaintDto {
  @IsString()
  resolutionNotes: string;
}

export class ComplaintQueryDto {
  @IsOptional()
  @IsEnum(ComplaintStatus)
  status?: ComplaintStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  interventionId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  userId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  assignedToId?: number;

  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  refundRequested?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  skip?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  take?: number;
}
