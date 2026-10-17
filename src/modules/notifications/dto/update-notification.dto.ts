import { IsBoolean, IsOptional } from 'class-validator';
import { OmitType, PartialType } from '@nestjs/mapped-types';

import { CreateNotificationDto } from './notification.dto';

/**
 * PATCH /notifications/:id (back office). Who receives a notification and what
 * kind it is cannot be changed afterwards; the rest can, and it can be marked
 * read or unread.
 */
export class UpdateNotificationDto extends PartialType(
  OmitType(CreateNotificationDto, ['recipientId', 'actorId', 'type'] as const),
) {
  @IsOptional()
  @IsBoolean()
  isRead?: boolean;
}
