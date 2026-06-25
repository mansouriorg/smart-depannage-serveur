import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
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
  title: string;

  @IsString()
  message: string;

  @IsOptional()
  @IsArray()
  @IsEnum(NotificationChannel, { each: true })
  channels?: NotificationChannel[];

  @IsOptional()
  @IsString()
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
  token: string;

  @IsOptional()
  @IsString()
  platform?: string;

  @IsOptional()
  @IsString()
  deviceId?: string;

  @IsOptional()
  @IsString()
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