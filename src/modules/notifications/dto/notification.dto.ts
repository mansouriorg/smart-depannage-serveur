import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

import {
  NotificationChannel,
  NotificationPriority,
  NotificationType,
} from '../../../../generated/prisma/client';

export class CreateNotificationDto {
  @IsInt()
  recipientId: number;

  @IsOptional()
  @IsInt()
  actorId?: number;

  @IsEnum(NotificationType)
  type: NotificationType;

  @IsOptional()
  @IsEnum(NotificationPriority)
  priority?: NotificationPriority;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  message: string;

  @IsOptional()
  @IsArray()
  @IsEnum(NotificationChannel, { each: true })
  channels?: NotificationChannel[];

  @IsOptional()
  @IsString()
  @MaxLength(50)
  entityType?: string;

  @IsOptional()
  @IsInt()
  entityId?: number;

  @IsOptional()
  @IsObject()
  data?: Record<string, any>;
}

export class RegisterPushTokenDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  token: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  platform?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  deviceId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  deviceName?: string;
}

export class UpdateNotificationPreferencesDto {
  @IsOptional()
  @IsBoolean()
  inAppEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  emailEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  smsEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  pushEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  adminRealtimeEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  interventionUpdates?: boolean;

  @IsOptional()
  @IsBoolean()
  quoteUpdates?: boolean;

  @IsOptional()
  @IsBoolean()
  paymentUpdates?: boolean;

  @IsOptional()
  @IsBoolean()
  invoiceUpdates?: boolean;

  @IsOptional()
  @IsBoolean()
  complaintUpdates?: boolean;

  @IsOptional()
  @IsBoolean()
  marketingUpdates?: boolean;

  @IsOptional()
  @IsBoolean()
  newInterventionCreated?: boolean;

  @IsOptional()
  @IsBoolean()
  artisanAssigned?: boolean;

  @IsOptional()
  @IsBoolean()
  artisanAcceptedMission?: boolean;

  @IsOptional()
  @IsBoolean()
  artisanOnTheWay?: boolean;

  @IsOptional()
  @IsBoolean()
  artisanArrived?: boolean;

  @IsOptional()
  @IsBoolean()
  workStarted?: boolean;

  @IsOptional()
  @IsBoolean()
  workCompleted?: boolean;

  @IsOptional()
  @IsBoolean()
  quoteSent?: boolean;

  @IsOptional()
  @IsBoolean()
  quoteAccepted?: boolean;

  @IsOptional()
  @IsBoolean()
  paymentReceived?: boolean;

  @IsOptional()
  @IsBoolean()
  invoiceReady?: boolean;

  @IsOptional()
  @IsBoolean()
  complaintOpened?: boolean;

  @IsOptional()
  @IsBoolean()
  complaintUpdated?: boolean;

  @IsOptional()
  @IsBoolean()
  artisanApplicationApproved?: boolean;

  @IsOptional()
  @IsBoolean()
  artisanApplicationRejected?: boolean;
}
