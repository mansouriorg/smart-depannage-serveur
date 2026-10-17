import { ArrayMaxSize, IsEnum, IsNotEmpty, IsString, IsOptional, IsArray, MaxLength } from 'class-validator';

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
  @MaxLength(2000)
  description: string;

  // 3. Address: Where the artisan needs to go
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  address: string;

  // 4. Photos: Optional array of URLs uploaded by the client.
  // Only used for a signed-in client: on the public route the service ignores it
  // (a link typed by a visitor would be shown to staff as a photo).
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @IsString({ each: true })
  @MaxLength(300, { each: true })
  photos?: string[];

  // ==========================================================
  // 5. GUEST CONTACT INFO (Optional)
  // These are used if the user is NOT logged in, allowing you 
  // to dynamically create a Client record in your Service layer
  // ==========================================================
  
  @IsOptional()
  @IsString()
  @MaxLength(100)
  contactName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  contactPhone?: string;
}
