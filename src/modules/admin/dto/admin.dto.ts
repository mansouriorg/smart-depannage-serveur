import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

import { INTERVENTION_NOTE_MAX } from '../../../common/views/case-file';

import {
  AdminNoteTargetType,
  ArtisanAvailabilityStatus,
  ArtisanDocumentStatus,
  ArtisanVerificationStatus,
  ComplaintStatus,
  NotificationTemplateType,
  PaymentMethod,
  QuoteStatus,
  Role,
  ServiceType,
  Status,
  UrgencyLevel,
} from '../../../../generated/prisma/client';

import { DISPATCH_SORTS, DISPATCH_VIEW_IDS } from '../../intervention-workflow/intervention-status';

// ==========================================================
// COMMON
// ==========================================================

export class PaginationQueryDto {
  @IsOptional()
  @IsString()
  page?: string;

  @IsOptional()
  @IsString()
  limit?: string;
}

export class AdminInternalNoteDto {
  @IsString()
  content: string;
}

/**
 * A note on a job (P1-14): text that the back office reads. The service trims it and refuses it blank
 * (`IsNotEmpty` lets "   " through); the longest allowed is INTERVENTION_NOTE_MAX, the number the
 * dashboard's form stops at.
 */
export class InterventionNoteDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(INTERVENTION_NOTE_MAX)
  content: string;
}

// ==========================================================
// DASHBOARD FILTERS
// ==========================================================

export class DashboardQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

// ==========================================================
// INTERVENTION MANAGEMENT
// ==========================================================

export class AdminInterventionQueryDto extends PaginationQueryDto {
  /** One status, in either spelling of the table (CREATED finds the PENDING rows too). */
  @IsOptional()
  @IsEnum(Status)
  status?: Status;

  /** A tab of the dispatcher's list (a group of statuses): toAssign, quote, active, done, cancelled, disputed. */
  @IsOptional()
  @IsIn(DISPATCH_VIEW_IDS)
  view?: string;

  @IsOptional()
  @IsEnum(UrgencyLevel)
  urgency?: UrgencyLevel;

  /** queue (most urgent first, then longest waiting), newest (the default) or oldest. */
  @IsOptional()
  @IsIn(DISPATCH_SORTS)
  sort?: string;

  @IsOptional()
  @IsEnum(ServiceType)
  serviceType?: ServiceType;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  artisanId?: string;

  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @IsOptional()
  @IsDateString()
  dateTo?: string;

  /** A job number, a name, a phone, an e-mail or a piece of the address (a longer text is cut to 100 characters, not refused). */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  search?: string;
}

export class AssignArtisanDto {
  @IsInt()
  artisanId: number;

  /** The visit, both or none: with them the artisan must be free for that time, and an appointment is made. */
  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @IsOptional()
  @IsDateString()
  endsAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  adminNote?: string;
}

export class ChangeInterventionStatusDto {
  @IsEnum(Status)
  status: Status;

  /** The status the person saw when choosing: if the job has moved since, nothing is written (409). */
  @IsOptional()
  @IsEnum(Status)
  expectedStatus?: Status;

  @IsOptional()
  @IsString()
  note?: string;
}

export class CancelInterventionDto {
  /** Read by the customer and the technician: never blank. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;

  /** The status the person saw when choosing: if the job has moved since, nothing is written (409). */
  @IsOptional()
  @IsEnum(Status)
  expectedStatus?: Status;
}

export class QuoteItemDto {
  @IsString()
  label: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsNumber()
  quantity: number;

  @IsNumber()
  unitPrice: number;
}

export class AdminSendQuoteDto {
  @IsString()
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsNumber()
  taxRate?: number;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => QuoteItemDto)
  items: QuoteItemDto[];
}

// ==========================================================
// ARTISAN MANAGEMENT
// ==========================================================

export class AdminArtisanQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(ArtisanVerificationStatus)
  status?: ArtisanVerificationStatus;

  @IsOptional()
  @IsString()
  search?: string;
}

export class CreateArtisanManualDto {
  @IsString()
  name: string;

  @IsEmail()
  email: string;

  @IsString()
  phone: string;

  @IsOptional()
  @IsString()
  companyName?: string;

  @IsOptional()
  @IsString()
  companyNumber?: string;

  @IsOptional()
  @IsString()
  insuranceNumber?: string;

  @IsOptional()
  @IsString()
  specialty?: string;

  @IsArray()
  @IsString({ each: true })
  specialties: string[];

  @IsInt()
  @Min(0)
  yearsExperience: number;

  @IsOptional()
  @IsString()
  bio?: string;

  @IsOptional()
  @IsString()
  profilePhotoUrl?: string;

  /** Numbers from GET /service-zones (P1-11). None: the artisan is not limited to a place. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(24)
  @IsInt({ each: true })
  zoneIds?: number[];
}

export class EditArtisanProfileDto {
  @IsOptional()
  @IsString()
  specialty?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  specialties?: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  yearsExperience?: number;

  @IsOptional()
  @IsString()
  companyName?: string;

  @IsOptional()
  @IsString()
  companyNumber?: string;

  @IsOptional()
  @IsString()
  insuranceNumber?: string;

  @IsOptional()
  @IsString()
  bio?: string;

  @IsOptional()
  @IsString()
  profilePhotoUrl?: string;

  @IsOptional()
  @IsEnum(ArtisanAvailabilityStatus)
  availabilityStatus?: ArtisanAvailabilityStatus;

  @IsOptional()
  @IsBoolean()
  isAcceptingJobs?: boolean;

  /** Takes urgent jobs. The assignment refuses an urgent job for an artisan who does not. */
  @IsOptional()
  @IsBoolean()
  emergencyAvailable?: boolean;

  /** How many jobs at a time; the assignment refuses one more. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  maxActiveJobs?: number;
}

export class AdminReviewArtisanDto {
  @IsOptional()
  @IsString()
  note?: string;
}

/** Accepting an application (P1-11). */
export class AdminApproveArtisanDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  /**
   * Approve an applicant who has no valid identity document. The reason (`note`) is then required
   * and is kept in the internal notes of the profile.
   */
  @IsOptional()
  @IsBoolean()
  waiveIdentityCheck?: boolean;
}

/** Refusing an application (P1-11): the reason is written, the applicant is told it. */
export class AdminRejectArtisanDto {
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason: string;
}

export class VerifyArtisanDocumentDto {
  @IsEnum(ArtisanDocumentStatus)
  status: ArtisanDocumentStatus;

  @IsOptional()
  @IsString()
  rejectionNote?: string;
}

// ==========================================================
// CLIENT MANAGEMENT
// ==========================================================

export class AdminClientQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  search?: string;
}

export class EditClientDto {
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  address?: string;
}

// ==========================================================
// COMPLAINT CENTER
// ==========================================================

export class AdminComplaintQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(ComplaintStatus)
  status?: ComplaintStatus;

  @IsOptional()
  @IsString()
  assignedToId?: string;

  @IsOptional()
  @IsString()
  search?: string;
}

export class AssignComplaintDto {
  @IsInt()
  supportAgentId: number;
}

export class UpdateComplaintStatusDto {
  @IsEnum(ComplaintStatus)
  status: ComplaintStatus;

  @IsOptional()
  @IsString()
  note?: string;
}

export class DecideRefundDto {
  @IsBoolean()
  approved: boolean;

  @IsOptional()
  @IsNumber()
  amount?: number;

  @IsOptional()
  @IsString()
  note?: string;
}

export class AdminContactDto {
  @IsString()
  content: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  attachments?: string[];
}

// ==========================================================
// SETTINGS
// ==========================================================

export class UpdateCompanySettingsDto {
  @IsOptional()
  @IsString()
  companyName?: string;

  @IsOptional()
  @IsString()
  companyPhone?: string;

  @IsOptional()
  @IsEmail()
  companyEmail?: string;

  @IsOptional()
  @IsString()
  smsSender?: string;

  @IsOptional()
  @IsNumber()
  defaultTaxRate?: number;

  @IsOptional()
  @IsNumber()
  defaultEmergencyFee?: number;

  @IsOptional()
  @IsObject()
  openingHours?: Record<string, any>;

  @IsOptional()
  @IsArray()
  @IsEnum(PaymentMethod, { each: true })
  paymentMethods?: PaymentMethod[];

  @IsOptional()
  @IsString()
  termsAndConditions?: string;

  @IsOptional()
  @IsString()
  privacyPolicy?: string;
}

export class CreateAdminServiceZoneDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  postalCode?: string;

  @IsOptional()
  @IsNumber()
  latitude?: number;

  @IsOptional()
  @IsNumber()
  longitude?: number;

  @IsOptional()
  @IsNumber()
  radiusKm?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateAdminServiceZoneDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  postalCode?: string;

  @IsOptional()
  @IsNumber()
  latitude?: number;

  @IsOptional()
  @IsNumber()
  longitude?: number;

  @IsOptional()
  @IsNumber()
  radiusKm?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateServiceCategoryPricingDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateSubServicePricingDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsNumber()
  estimatedDuration?: number;

  @IsOptional()
  @IsNumber()
  basePrice?: number;

  @IsOptional()
  @IsNumber()
  emergencyPrice?: number;

  @IsOptional()
  @IsBoolean()
  requiresPhotos?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateNotificationTemplateDto {
  @IsString()
  key: string;

  @IsEnum(NotificationTemplateType)
  type: NotificationTemplateType;

  @IsOptional()
  @IsString()
  subject?: string;

  @IsString()
  content: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateNotificationTemplateDto {
  @IsOptional()
  @IsEnum(NotificationTemplateType)
  type?: NotificationTemplateType;

  @IsOptional()
  @IsString()
  subject?: string;

  @IsOptional()
  @IsString()
  content?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
