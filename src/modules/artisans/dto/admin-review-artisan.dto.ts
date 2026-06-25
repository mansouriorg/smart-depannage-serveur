import { IsOptional, IsString } from 'class-validator';

export class AdminReviewArtisanDto {
  @IsOptional()
  @IsString()
  note?: string;
}