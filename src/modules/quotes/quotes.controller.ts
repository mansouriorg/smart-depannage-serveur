import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';

import { QuotesService } from './quotes.service';
import { CreateQuoteDto } from './dto/create-quote.dto';
import { UpdateQuoteDto } from './dto/quote.dto';
import { ClientQuoteActionDto } from './dto/client-quote-action.dto';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Permission } from '../../common/auth/permissions';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

import { Role } from '../../../generated/prisma/client';
import { isBackOffice } from '../../common/auth/role-policy';
import { quoteForArtisan } from '../../common/views/views';

@Controller('quotes')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class QuotesController {
  constructor(private readonly service: QuotesService) {}

  /**
   * The back office gets the quote as it is; an artisan gets the copy built for them (no name or
   * address of who wrote it, the job inside in the artisan's shape).
   */
  private forReader(role: Role, quote: any) {
    return isBackOffice(role) ? quote : quoteForArtisan(quote);
  }

  // ==========================================================
  // 1. ADMIN / ARTISAN - CREATE QUOTE
  // ==========================================================

  /**
   * Create and immediately send quote for an intervention.
   *
   * POST /quotes/interventions/:interventionId
   */
  @RequirePermission(Permission.QUOTES_WRITE)
  @Post('interventions/:interventionId')
  async createForIntervention(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('interventionId', ParseIntPipe) interventionId: number,
    @Body() dto: CreateQuoteDto,
  ) {
    return this.forReader(role, await this.service.createForIntervention(interventionId, userId, dto));
  }

  /**
   * Create a draft quote for an intervention.
   *
   * POST /quotes/interventions/:interventionId/draft
   */
  @RequirePermission(Permission.QUOTES_WRITE)
  @Post('interventions/:interventionId/draft')
  async createDraftForIntervention(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('interventionId', ParseIntPipe) interventionId: number,
    @Body() dto: CreateQuoteDto,
  ) {
    return this.forReader(
      role,
      await this.service.createDraftForIntervention(interventionId, userId, dto),
    );
  }

  // ==========================================================
  // 2. CLIENT / ADMIN - QUOTES BY INTERVENTION
  // ==========================================================

  /**
   * Client can view quotes for their intervention.
   * Admins can also use this route if your service allows it later.
   *
   * GET /quotes/interventions/:interventionId
   */
  @RequirePermission(Permission.QUOTES_FOR_JOB)
  @Get('interventions/:interventionId')
  findForClient(
    @CurrentUser('id') userId: number,
    @Param('interventionId', ParseIntPipe) interventionId: number,
  ) {
    return this.service.findForClient(userId, interventionId);
  }

  // ==========================================================
  // 3. ADMIN / ARTISAN - QUOTE MANAGEMENT
  // ==========================================================

  /**
   * Update quote content, items, prices, tax, PDF URL, expiration date.
   *
   * PATCH /quotes/:quoteId
   */
  @RequirePermission(Permission.QUOTES_WRITE)
  @Patch(':quoteId')
  async updateQuote(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('quoteId', ParseIntPipe) quoteId: number,
    @Body() dto: UpdateQuoteDto,
  ) {
    return this.forReader(role, await this.service.updateQuote(quoteId, userId, dto));
  }

  /**
   * Send an existing draft quote.
   *
   * POST /quotes/:quoteId/send
   */
  @RequirePermission(Permission.QUOTES_WRITE)
  @Post(':quoteId/send')
  async sendQuote(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('quoteId', ParseIntPipe) quoteId: number,
  ) {
    return this.forReader(role, await this.service.sendQuote(quoteId, userId));
  }

  /**
   * Cancel quote.
   *
   * POST /quotes/:quoteId/cancel
   */
  @RequirePermission(Permission.QUOTES_WRITE)
  @Post(':quoteId/cancel')
  async cancelQuote(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('quoteId', ParseIntPipe) quoteId: number,
    @Body() dto: ClientQuoteActionDto,
  ) {
    return this.forReader(role, await this.service.cancelQuote(quoteId, userId, dto));
  }

  /**
   * Mark quote as expired.
   *
   * POST /quotes/:quoteId/expire
   */
  @RequirePermission(Permission.QUOTES_EXPIRE)
  @Post(':quoteId/expire')
  expireQuote(
    @CurrentUser('id') userId: number,
    @Param('quoteId', ParseIntPipe) quoteId: number,
  ) {
    return this.service.expireQuote(quoteId, userId);
  }

  /**
   * Attach or update quote PDF URL.
   *
   * PATCH /quotes/:quoteId/pdf
   *
   * Body:
   * {
   *   "pdfUrl": "/uploads/quotes/quote-12.pdf"
   * }
   */
  @RequirePermission(Permission.QUOTES_WRITE)
  @Patch(':quoteId/pdf')
  async setPdfUrl(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('quoteId', ParseIntPipe) quoteId: number,
    @Body('pdfUrl') pdfUrl: string,
  ) {
    return this.forReader(role, await this.service.setPdfUrl(quoteId, pdfUrl, userId));
  }

  // ==========================================================
  // 4. CLIENT ACTIONS
  // ==========================================================

  /**
   * Client accepts quote.
   *
   * POST /quotes/:quoteId/accept
   */
  @RequirePermission(Permission.QUOTES_RESPOND)
  @Post(':quoteId/accept')
  accept(
    @CurrentUser('id') userId: number,
    @Param('quoteId', ParseIntPipe) quoteId: number,
    @Body() dto: ClientQuoteActionDto,
  ) {
    return this.service.accept(userId, quoteId, dto);
  }

  /**
   * Client rejects quote.
   *
   * POST /quotes/:quoteId/reject
   */
  @RequirePermission(Permission.QUOTES_RESPOND)
  @Post(':quoteId/reject')
  reject(
    @CurrentUser('id') userId: number,
    @Param('quoteId', ParseIntPipe) quoteId: number,
    @Body() dto: ClientQuoteActionDto,
  ) {
    return this.service.reject(userId, quoteId, dto);
  }

  /**
   * Client requests quote modification.
   *
   * POST /quotes/:quoteId/request-modification
   */
  @RequirePermission(Permission.QUOTES_RESPOND)
  @Post(':quoteId/request-modification')
  requestModification(
    @CurrentUser('id') userId: number,
    @Param('quoteId', ParseIntPipe) quoteId: number,
    @Body() dto: ClientQuoteActionDto,
  ) {
    return this.service.requestModification(userId, quoteId, dto);
  }

  /**
   * Client asks a question about quote.
   *
   * POST /quotes/:quoteId/question
   */
  @RequirePermission(Permission.QUOTES_RESPOND)
  @Post(':quoteId/question')
  askQuestion(
    @CurrentUser('id') userId: number,
    @Param('quoteId', ParseIntPipe) quoteId: number,
    @Body() dto: ClientQuoteActionDto,
  ) {
    return this.service.askQuestion(userId, quoteId, dto);
  }

  /**
   * Client downloads quote PDF or gets quote data if PDF is not generated.
   *
   * GET /quotes/:quoteId/download
   */
  @RequirePermission(Permission.QUOTES_RESPOND)
  @Get(':quoteId/download')
  download(
    @CurrentUser('id') userId: number,
    @Param('quoteId', ParseIntPipe) quoteId: number,
  ) {
    return this.service.downloadForClient(userId, quoteId);
  }

  // ==========================================================
  // 5. ADMIN / SYSTEM
  // ==========================================================

  /**
   * List expired sent quotes.
   * Useful later for a cron job.
   *
   * GET /quotes/system/expired
   *
   * Important: this route must stay before GET /quotes/:quoteId.
   */
  @RequirePermission(Permission.QUOTES_EXPIRE)
  @Get('system/expired')
  findExpiredQuotes() {
    return this.service.findExpiredQuotes();
  }

  /**
   * The versions that edits replaced, and the revision the quote is at.
   *
   * GET /quotes/:quoteId/revisions
   */
  @RequirePermission(Permission.QUOTES_READ)
  @Get(':quoteId/revisions')
  findRevisions(
    @CurrentUser() user: { id: number; role: Role },
    @Param('quoteId', ParseIntPipe) quoteId: number,
  ) {
    return this.service.findRevisions(quoteId, user);
  }

  /**
   * Admin/artisan quote detail.
   *
   * GET /quotes/:quoteId
   */
  @RequirePermission(Permission.QUOTES_READ)
  @Get(':quoteId')
  findOne(
    @CurrentUser() user: { id: number; role: Role },
    @Param('quoteId', ParseIntPipe) quoteId: number,
  ) {
    return this.service.findOne(quoteId, user);
  }
}
