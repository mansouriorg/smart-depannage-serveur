import { IsArray, IsEnum, IsOptional, IsString } from 'class-validator';
import { MessageAudience } from '../../../../generated/prisma/client';

export class CreateMessageDto {
  @IsEnum(MessageAudience)
  audience: MessageAudience;

  @IsString()
  content: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  attachments?: string[];
}