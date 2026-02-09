import { IsEnum, IsNotEmpty, IsString, IsOptional } from 'class-validator';

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

  // 4. Photos: Optional array of URLs
  @IsOptional()
  @IsString({ each: true })
  photos?: string[];

  // ==========================================================
  // 5. GUEST CONTACT INFO (Optional)
  // These are used if the user is NOT logged in
  // ==========================================================
  
  @IsOptional()
  @IsString()
  contactName?: string;

  @IsOptional()
  @IsString()
  contactPhone?: string;
}