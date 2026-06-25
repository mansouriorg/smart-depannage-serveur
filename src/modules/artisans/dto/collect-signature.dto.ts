import { IsOptional, IsString } from 'class-validator';

export class CollectSignatureDto {
  @IsString()
  signatureUrl: string;

  @IsOptional()
  @IsString()
  signedByName?: string;
}