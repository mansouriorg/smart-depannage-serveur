import { IsArray, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class MaterialUsedItemDto {
  @IsString()
  name: string;

  @IsNumber()
  quantity: number;

  @IsOptional()
  @IsString()
  unit?: string;

  @IsOptional()
  @IsNumber()
  unitPrice?: number;
}

export class AddMaterialUsedDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MaterialUsedItemDto)
  items: MaterialUsedItemDto[];
}