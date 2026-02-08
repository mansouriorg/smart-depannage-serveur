import { IsEnum, IsNotEmpty, IsString, IsOptional } from 'class-validator';
import { ServiceType } from '@prisma/client'; // Import the Enum directly from Prisma

export class CreateInterventionDto {
  // 1. Service Type: Must be one of your defined types (PLOMBIER, SERRURIER, etc.)
  @IsEnum(ServiceType, {
    message: 'Service type must be PLOMBIER, MENUISIER, SERRURIER, ELECTRICIEN, or AUTRE',
  })
  serviceType: ServiceType;

  // 2. Description: What is the problem? (e.g., "Leaky faucet")
  @IsString()
  @IsNotEmpty()
  description: string;

  // 3. Address: Where should the artisan go?
  @IsString()
  @IsNotEmpty()
  address: string;

  // 4. Photos: Optional array of URLs (we will handle file uploads later)
  @IsOptional()
  @IsString({ each: true }) // Validates that each item in the array is a string
  photos?: string[];
}