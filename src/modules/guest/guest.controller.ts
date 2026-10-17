import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { GuestService } from './guest.service';
import {
  RateLimit,
  RateLimitGuard,
} from '../../common/rate-limit/rate-limit.guard';

import { CreateGuestInterventionDto } from './dto/create-guest-intervention.dto';
import { GuestQuoteActionDto } from './dto/guest-quote-action.dto';
import { GuestPaymentDto } from './dto/guest-payment.dto';
import { GuestFeedbackDto } from './dto/guest-feedback.dto';
import { RequestGuestActivationDto } from './dto/request-guest-activation.dto';
import { ActivateGuestAccountDto } from './dto/activate-guest-account.dto';

@Controller('guest')
export class GuestController {
  constructor(private readonly guestService: GuestService) {}

  // ==========================================================
  // 1. CREATE REQUEST WITHOUT ACCOUNT
  // POST /guest/interventions
  // ==========================================================

  @UseGuards(RateLimitGuard)
  @RateLimit({ name: 'guest-create', limit: 10, windowMs: 60 * 60_000 })
  @Post('interventions')
  createGuestIntervention(@Body() dto: CreateGuestInterventionDto) {
    return this.guestService.createGuestIntervention(dto);
  }

  // ==========================================================
  // 2. TRACK REQUEST WITH SECURE LINK
  // GET /guest/tracking/:id?token=RAW_TOKEN
  // ==========================================================

  @Get('tracking/:id')
  track(
    @Param('id', ParseIntPipe) id: number,
    @Query('token') token: string,
  ) {
    return this.guestService.track(id, token);
  }

  // ==========================================================
  // 3. RECEIVE / VIEW QUOTES
  // GET /guest/interventions/:id/quotes?token=RAW_TOKEN
  // ==========================================================

  @Get('interventions/:id/quotes')
  getQuotes(
    @Param('id', ParseIntPipe) id: number,
    @Query('token') token: string,
  ) {
    return this.guestService.getQuotes(id, token);
  }

  // ==========================================================
  // 4. ACCEPT QUOTE
  // POST /guest/interventions/:id/quotes/:quoteId/accept?token=RAW_TOKEN
  // ==========================================================

  @Post('interventions/:id/quotes/:quoteId/accept')
  acceptQuote(
    @Param('id', ParseIntPipe) id: number,
    @Param('quoteId', ParseIntPipe) quoteId: number,
    @Query('token') token: string,
    @Body() dto: GuestQuoteActionDto,
  ) {
    return this.guestService.acceptQuote(id, quoteId, token, dto);
  }

  // ==========================================================
  // 5. REJECT QUOTE
  // POST /guest/interventions/:id/quotes/:quoteId/reject?token=RAW_TOKEN
  // ==========================================================

  @Post('interventions/:id/quotes/:quoteId/reject')
  rejectQuote(
    @Param('id', ParseIntPipe) id: number,
    @Param('quoteId', ParseIntPipe) quoteId: number,
    @Query('token') token: string,
    @Body() dto: GuestQuoteActionDto,
  ) {
    return this.guestService.rejectQuote(id, quoteId, token, dto);
  }

  // ==========================================================
  // 6. REQUEST QUOTE MODIFICATION
  // POST /guest/interventions/:id/quotes/:quoteId/request-modification?token=RAW_TOKEN
  // ==========================================================

  @Post('interventions/:id/quotes/:quoteId/request-modification')
  requestQuoteModification(
    @Param('id', ParseIntPipe) id: number,
    @Param('quoteId', ParseIntPipe) quoteId: number,
    @Query('token') token: string,
    @Body() dto: GuestQuoteActionDto,
  ) {
    return this.guestService.requestQuoteModification(
      id,
      quoteId,
      token,
      dto,
    );
  }

  // ==========================================================
  // 7. GUEST PAYMENT
  // POST /guest/interventions/:id/payments?token=RAW_TOKEN
  // ==========================================================

  @Post('interventions/:id/payments')
  createGuestPayment(
    @Param('id', ParseIntPipe) id: number,
    @Query('token') token: string,
    @Body() dto: GuestPaymentDto,
  ) {
    return this.guestService.createGuestPayment(id, token, dto);
  }

  // ==========================================================
  // 8. SUBMIT FEEDBACK
  // POST /guest/interventions/:id/feedback?token=RAW_TOKEN
  // ==========================================================

  @Post('interventions/:id/feedback')
  submitFeedback(
    @Param('id', ParseIntPipe) id: number,
    @Query('token') token: string,
    @Body() dto: GuestFeedbackDto,
  ) {
    return this.guestService.submitFeedback(id, token, dto);
  }

  // ==========================================================
  // 9. REQUEST ACCOUNT ACTIVATION
  // POST /guest/account/request-activation
  // ==========================================================

  @UseGuards(RateLimitGuard)
  @RateLimit({ name: 'guest-request-activation', limit: 5, windowMs: 15 * 60_000 })
  @Post('account/request-activation')
  requestAccountActivation(@Body() dto: RequestGuestActivationDto) {
    return this.guestService.requestAccountActivation(dto);
  }

  // ==========================================================
  // 10. ACTIVATE ACCOUNT
  // POST /guest/account/activate
  // ==========================================================

  @UseGuards(RateLimitGuard)
  @RateLimit({ name: 'guest-activate', limit: 10, windowMs: 15 * 60_000 })
  @Post('account/activate')
  activateGuestAccount(@Body() dto: ActivateGuestAccountDto) {
    return this.guestService.activateGuestAccount(dto);
  }
}
