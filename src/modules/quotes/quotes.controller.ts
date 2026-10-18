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
import { ClientQuoteActionDto } from './dto/client-quote-action.dto';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

import { Role } from '../../../generated/prisma/client';
import { isBackOffice } from '../../common/auth/role-policy';
import { quoteForArtisan } from '../../common/views/views';

@Controller('quotes')
@UseGuards(JwtAuthGuard, RolesGuard)
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
  @Roles(
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
    Role.ARTISAN,
  )
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
  @Roles(
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
    Role.ARTISAN,
  )
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
  @Roles(Role.CLIENT, Role.ADMIN, Role.SUPER_ADMIN, Role.SUPPORT, Role.DISPATCHER)
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
  @Roles(
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
    Role.ARTISAN,
  )
  @Patch(':quoteId')
  async updateQuote(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('quoteId', ParseIntPipe) quoteId: number,
    @Body() dto: Partial<CreateQuoteDto>,
  ) {
    return this.forReader(role, await this.service.updateQuote(quoteId, userId, dto));
  }

  /**
   * Send an existing draft quote.
   *
   * POST /quotes/:quoteId/send
   */
  @Roles(
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
    Role.ARTISAN,
  )
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
  @Roles(
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
    Role.ARTISAN,
  )
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
  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.SUPPORT, Role.DISPATCHER)
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
  @Roles(
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
    Role.ARTISAN,
  )
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
  @Roles(Role.CLIENT)
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
  @Roles(Role.CLIENT)
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
  @Roles(Role.CLIENT)
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
  @Roles(Role.CLIENT)
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
  @Roles(Role.CLIENT)
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
  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.SUPPORT, Role.DISPATCHER)
  @Get('system/expired')
  findExpiredQuotes() {
    return this.service.findExpiredQuotes();
  }

  /**
   * Admin/artisan quote detail.
   *
   * GET /quotes/:quoteId
   */
  @Roles(
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
    Role.ACCOUNTANT,
    Role.ARTISAN,
  )
  @Get(':quoteId')
  findOne(
    @CurrentUser() user: { id: number; role: Role },
    @Param('quoteId', ParseIntPipe) quoteId: number,
  ) {
    return this.service.findOne(quoteId, user);
  }
}
