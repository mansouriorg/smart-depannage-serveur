import {
  IsEnum,
  IsOptional,
  IsString,
} from 'class-validator';

import {
  ArtisanDocumentType,
  FileAssetVisibility,
} from '../../../../generated/prisma/client';

export class UploadArtisanDocumentDto {
  @IsEnum(ArtisanDocumentType)
  type: ArtisanDocumentType;

  @IsOptional()
  @IsEnum(FileAssetVisibility)
  visibility?: FileAssetVisibility;
}

export class SetFileVisibilityDto {
  @IsEnum(FileAssetVisibility)
  visibility: FileAssetVisibility;
}

export class SetPublicAccessDto {
  @IsOptional()
  @IsString()
  reason?: string;
}