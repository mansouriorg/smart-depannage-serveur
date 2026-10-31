import { ArrayMaxSize, IsEnum, IsNotEmpty, IsString, IsOptional, IsArray, MaxLength } from 'class-validator';

// ✅ Import from your custom generated location
// Adjust the number of '../' if your file is located deeper or shallower
import { ServiceType } from '../../../../generated/prisma/client'; 
import { TRADE_CODES } from '../../../common/trades/trades';
import { BotCheckFields } from '../../../common/bot-check/bot-check.dto';

// The three fields of BotCheckFields were read on the public request route, deleted in P3-03; the secure route ignores them (P1-16).
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
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @IsString({ each: true })
  @MaxLength(300, { each: true })
  photos?: string[];

  // ==========================================================
  // 5. CONTACT INFO (Optional)
  // Accepted so that a form that sends them is not refused; the request is made for the signed-in account and the service
  // does not store them (they served the public request route, deleted in P3-03).
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
