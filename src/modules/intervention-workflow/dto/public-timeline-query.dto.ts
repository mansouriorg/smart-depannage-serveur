import { IsString } from 'class-validator';

export class PublicTimelineQueryDto {
  @IsString()
  token: string;
}