import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { MessagesService } from './messages.service';
import { CreateMessageDto } from './dto/create-message.dto';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

import {
  MessageAudience,
  Role,
} from '../../../generated/prisma/client';

type AdminInternalNoteDto = {
  content: string;
};

@Controller('messages')
@UseGuards(JwtAuthGuard)
export class MessagesController {
  constructor(private readonly service: MessagesService) {}

  // ==========================================================
  // 1. SEND PUBLIC MESSAGE
  // Client ↔ Artisan
  // Client ↔ Admin
  // Artisan ↔ Admin
  // ==========================================================

  /**
   * Send message.
   *
   * POST /messages/interventions/:interventionId
   *
   * Body examples:
   *
   * Client ↔ Artisan:
   * {
   *   "audience": "CLIENT_ARTISAN",
   *   "content": "Bonjour, êtes-vous bientôt sur place ?"
   * }
   *
   * Client ↔ Admin:
   * {
   *   "audience": "CLIENT_SUPPORT",
   *   "content": "J’ai besoin d’aide sur cette intervention."
   * }
   *
   * Artisan ↔ Admin:
   * {
   *   "audience": "ARTISAN_SUPPORT",
   *   "content": "Je dois demander un supplément."
   * }
   *
   * With attachment:
   * {
   *   "audience": "CLIENT_ARTISAN",
   *   "content": "Voici la photo.",
   *   "attachments": ["/files/15/download"]
   * }
   */
  @Post('interventions/:interventionId')
  create(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('interventionId', ParseIntPipe) interventionId: number,
    @Body() dto: CreateMessageDto,
  ) {
    return this.service.create(userId, role, interventionId, dto);
  }

  // ==========================================================
  // 2. GET MESSAGES BY INTERVENTION
  // ==========================================================

  /**
   * Get messages for one intervention.
   *
   * GET /messages/interventions/:interventionId
   * GET /messages/interventions/:interventionId?audience=CLIENT_ARTISAN
   * GET /messages/interventions/:interventionId?audience=CLIENT_SUPPORT
   * GET /messages/interventions/:interventionId?audience=ARTISAN_SUPPORT
   */
  @Get('interventions/:interventionId')
  findByIntervention(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('interventionId', ParseIntPipe) interventionId: number,
    @Query('audience') audience?: MessageAudience,
  ) {
    return this.service.findByIntervention(
      userId,
      role,
      interventionId,
      audience,
    );
  }

  // ==========================================================
  // 3. UNREAD COUNTERS
  // Must stay before GET /messages/:messageId
  // ==========================================================

  /**
   * Count all unread messages for current user.
   *
   * GET /messages/unread/count
   */
  @Get('unread/count')
  countUnread(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
  ) {
    return this.service.countUnread(userId, role);
  }

  /**
   * Count unread messages for one intervention.
   *
   * GET /messages/interventions/:interventionId/unread/count
   */
  @Get('interventions/:interventionId/unread/count')
  countUnreadForIntervention(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('interventionId', ParseIntPipe) interventionId: number,
  ) {
    return this.service.countUnreadForIntervention(
      userId,
      role,
      interventionId,
    );
  }

  // ==========================================================
  // 4. MARK MESSAGES AS READ
  // Must stay before PATCH /messages/:messageId
  // ==========================================================

  /**
   * Mark all messages in one intervention as read.
   *
   * PATCH /messages/interventions/:interventionId/read
   * PATCH /messages/interventions/:interventionId/read?audience=CLIENT_SUPPORT
   */
  @Patch('interventions/:interventionId/read')
  markInterventionAsRead(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('interventionId', ParseIntPipe) interventionId: number,
    @Query('audience') audience?: MessageAudience,
  ) {
    return this.service.markInterventionAsRead(
      userId,
      role,
      interventionId,
      audience,
    );
  }

  /**
   * Mark one message as read.
   *
   * PATCH /messages/:messageId/read
   */
  @Patch(':messageId/read')
  markAsRead(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('messageId', ParseIntPipe) messageId: number,
  ) {
    return this.service.markAsRead(userId, role, messageId);
  }

  // ==========================================================
  // 5. ADMIN INTERNAL NOTES
  // Completely separate from public messages
  // ==========================================================

  /**
   * Create internal admin note.
   *
   * POST /messages/admin-notes/interventions/:interventionId
   *
   * Body:
   * {
   *   "content": "Note interne: client prioritaire."
   * }
   */
  @Post('admin-notes/interventions/:interventionId')
  createInternalNote(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('interventionId', ParseIntPipe) interventionId: number,
    @Body() dto: AdminInternalNoteDto,
  ) {
    return this.service.createInternalNote(
      userId,
      role,
      interventionId,
      dto,
    );
  }

  /**
   * Get internal admin notes for intervention.
   *
   * GET /messages/admin-notes/interventions/:interventionId
   */
  @Get('admin-notes/interventions/:interventionId')
  findInternalNotesByIntervention(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('interventionId', ParseIntPipe) interventionId: number,
  ) {
    return this.service.findInternalNotesByIntervention(
      userId,
      role,
      interventionId,
    );
  }

  /**
   * Delete internal admin note.
   *
   * DELETE /messages/admin-notes/:noteId
   */
  @Delete('admin-notes/:noteId')
  deleteInternalNote(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('noteId', ParseIntPipe) noteId: number,
  ) {
    return this.service.deleteInternalNote(userId, role, noteId);
  }

  // ==========================================================
  // 6. MESSAGE DETAILS
  // Must stay after all specific GET routes
  // ==========================================================

  /**
   * Get one message.
   *
   * GET /messages/:messageId
   */
  @Get(':messageId')
  findOne(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('messageId', ParseIntPipe) messageId: number,
  ) {
    return this.service.findOne(userId, role, messageId);
  }

  // ==========================================================
  // 7. DELETE PUBLIC MESSAGE
  // Soft delete
  // ==========================================================

  /**
   * Delete one message.
   *
   * DELETE /messages/:messageId
   */
  @Delete(':messageId')
  remove(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('messageId', ParseIntPipe) messageId: number,
  ) {
    return this.service.remove(userId, role, messageId);
  }
}