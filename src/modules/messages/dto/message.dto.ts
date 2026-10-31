import {
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
} from 'class-validator';

import { MessageAudience } from '../../../../generated/prisma/client';

export class SendMessageDto {
  @IsEnum(MessageAudience)
  audience: MessageAudience;

  @IsOptional()
  @IsString()
  content?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  attachments?: string[];
}

export class MessageQueryDto {
  @IsOptional()
  @IsEnum(MessageAudience)
  audience?: MessageAudience;
}
