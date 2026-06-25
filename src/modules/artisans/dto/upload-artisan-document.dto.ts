import { IsEnum, IsOptional, IsString } from 'class-validator';
import { ArtisanDocumentType } from '../../../../generated/prisma/client';

export class UploadArtisanDocumentDto {
  @IsEnum(ArtisanDocumentType)
  type: ArtisanDocumentType;

  @IsString()
  fileUrl: string;

  @IsOptional()
  @IsString()
  fileName?: string;

  @IsOptional()
  @IsString()
  mimeType?: string;
}