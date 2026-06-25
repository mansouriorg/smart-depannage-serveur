import {
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';

import { InterventionEventType } from '../../../../generated/prisma/client';

export class CreateTimelineEventDto {
  @IsEnum(InterventionEventType)
  type: InterventionEventType;

  @IsString()
  title: string;

  @IsOptional()
  @IsString()
  message?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}