import { ArrayMaxSize, IsEnum, IsNotEmpty, IsString, IsOptional, IsArray, MaxLength } from 'class-validator';

// ✅ Import from your custom generated location
// Adjust the number of '../' if your file is located deeper or shallower
import { ServiceType } from '../../../../generated/prisma/client'; 
import { TRADE_CODES } from '../../../common/trades/trades';
import { BotCheckFields } from '../../../common/bot-check/bot-check.dto';

// The three fields of BotCheckFields are read on POST /interventions (no account) and ignored on the secure route (P1-16).
export class CreateInterventionDto extends BotCheckFields {
  // 1. Service Type: Must match the Enum in your Schema (PLOMBIER, etc.)
  @IsEnum(ServiceType, {
    // The list comes from the table of trades, so a new trade is named here without touching this file (P1-10)
    message: `Service type must be one of: ${TRADE_CODES.join(', ')}`,
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
