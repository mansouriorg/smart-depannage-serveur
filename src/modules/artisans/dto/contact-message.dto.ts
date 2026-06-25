import { IsArray, IsOptional, IsString } from 'class-validator';

export class ContactMessageDto {
  @IsString()
  content: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  attachments?: string[];
}