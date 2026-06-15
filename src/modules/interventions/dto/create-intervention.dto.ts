import { IsEnum, IsNotEmpty, IsString, IsOptional, IsArray } from 'class-validator';

// ✅ Import from your custom generated location
// Adjust the number of '../' if your file is located deeper or shallower
import { ServiceType } from '../../../../generated/prisma/client'; 

export class CreateInterventionDto {
  // 1. Service Type: Must match the Enum in your Schema (PLOMBIER, etc.)
  @IsEnum(ServiceType, {
    message: 'Service type must be PLOMBIER, MENUISIER, SERRURIER, ELECTRICIEN, or AUTRE',
  })
  serviceType: ServiceType;

  // 2. Description: The problem details
  @IsString()
  @IsNotEmpty()
  description: string;

  // 3. Address: Where the artisan needs to go
  @IsString()
  @IsNotEmpty()
  address: string;

  // 4. Photos: Optional array of URLs uploaded by the client
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  photos?: string[];

  // ==========================================================
  // 5. GUEST CONTACT INFO (Optional)
  // These are used if the user is NOT logged in, allowing you 
  // to dynamically create a Client record in your Service layer
  // ==========================================================
  
  @IsOptional()
  @IsString()
  contactName?: string;

  @IsOptional()
  @IsString()
  contactPhone?: string;
}