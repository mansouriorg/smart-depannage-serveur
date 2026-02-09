import { IsEnum, IsNotEmpty, IsString, IsOptional } from 'class-validator';

// ❌ OLD: import { ServiceType } from '@prisma/client'; 

// ✅ NEW: Import from your custom generated location
// Adjust the '../' number based on your folder structure. 
// If your file is deep in src/modules/interventions/dto/, you likely need 4 levels up.
import { ServiceType } from '../../../../generated/prisma/client'; 

export class CreateInterventionDto {
  // 1. Service Type
  @IsEnum(ServiceType, {
    message: 'Service type must be PLOMBIER, MENUISIER, SERRURIER, ELECTRICIEN, or AUTRE',
  })
  serviceType: ServiceType;

  // 2. Description
  @IsString()
  @IsNotEmpty()
  description: string;

  // 3. Address
  @IsString()
  @IsNotEmpty()
  address: string;

  // 4. Photos
  @IsOptional()
  @IsString({ each: true })
  photos?: string[];
}