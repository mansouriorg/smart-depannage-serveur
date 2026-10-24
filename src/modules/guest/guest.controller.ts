import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Ip,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';

import { GuestService } from './guest.service';
import { BotCheckGuard } from '../../common/bot-check/bot-check.guard';
import { BotCheckService } from '../../common/bot-check/bot-check.service';
import { GuestTrackingLinkGuard } from './guest-tracking-link.guard';
import {
  RateLimit,
  RateLimitGuard,
} from '../../common/rate-limit/rate-limit.guard';

import { CreateGuestInterventionDto } from './dto/create-guest-intervention.dto';
import { GuestQuoteActionDto } from './dto/guest-quote-action.dto';
import { GuestPaymentDto } from './dto/guest-payment.dto';
import { GuestFeedbackDto } from './dto/guest-feedback.dto';
import { GuestProblemReportDto } from './dto/guest-problem-report.dto';
import { RequestGuestActivationDto } from './dto/request-guest-activation.dto';
import { ActivateGuestAccountDto } from './dto/activate-guest-account.dto';

@Controller('guest')
export class GuestController {
  constructor(
    private readonly guestService: GuestService,
    private readonly botCheck: BotCheckService,
  ) {}

  // ==========================================================
  // 0. CHALLENGE FOR THE REQUEST FORM (P1-16)
  // GET /guest/challenge
  // A signed puzzle the page solves in the background and sends back with the form
  // (botChallenge + botSolution). `{ enabled: false }` when the check is off.
  // ==========================================================

  // Every visit to the form takes one, read or not, and many phones share one public address (the operators' shared
  // addresses), so the bucket is wide: sending is what is limited tightly (10 an hour, below). Never kept by a cache: a
  // puzzle is good once, for one person.
  @UseGuards(RateLimitGuard)
  @RateLimit({ name: 'guest-challenge', limit: 240, windowMs: 60 * 60_000 })
  @Header('Cache-Control', 'no-store')
  @Get('challenge')
  challenge() {
    return this.botCheck.issue();
  }

  // ==========================================================
  // 1. CREATE REQUEST WITHOUT ACCOUNT
  // POST /guest/interventions
  // ==========================================================

  // Counted first, then checked: a script that fails the check still uses up its tries (P1-16).
  @UseGuards(RateLimitGuard, BotCheckGuard)
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
  // 6b. ASK A QUESTION ABOUT A QUOTE (the quote stays as it is)
  // POST /guest/interventions/:id/quotes/:quoteId/question?token=RAW_TOKEN
  // ==========================================================

  @Post('interventions/:id/quotes/:quoteId/question')
  askQuoteQuestion(
    @Param('id', ParseIntPipe) id: number,
    @Param('quoteId', ParseIntPipe) quoteId: number,
    @Query('token') token: string,
    @Body() dto: GuestQuoteActionDto,
  ) {
    return this.guestService.askQuoteQuestion(id, quoteId, token, dto);
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
  // 8b. ADD PHOTOS (P1-04)
  // POST /guest/interventions/:id/photos?token=RAW_TOKEN
  // multipart/form-data, field "photos", up to 5 pictures of 5 MB
  // (JPEG, PNG or WebP), 6 photos in all per request.
  // ==========================================================

  // The guards run before the upload is read: the visitor's address is counted first,
  // then the link is checked, so a made-up link costs the server no memory.
  @UseGuards(RateLimitGuard, GuestTrackingLinkGuard)
  @RateLimit({ name: 'guest-photos', limit: 30, windowMs: 60 * 60_000 })
  @Post('interventions/:id/photos')
  @UseInterceptors(
    FilesInterceptor('photos', GuestService.MAX_PHOTOS_PER_CALL, {
      // In memory, then checked and re-encoded by the files service: nothing a
      // visitor sends is written to disk as it came.
      storage: memoryStorage(),
      // Nothing but the pictures: no text fields (they would be buffered too),
      // no more parts than pictures, small headers.
      limits: {
        fileSize: 5 * 1024 * 1024,
        files: GuestService.MAX_PHOTOS_PER_CALL,
        fields: 0,
        parts: GuestService.MAX_PHOTOS_PER_CALL + 1,
        fieldSize: 1024,
        headerPairs: 20,
      },
      fileFilter: (_request, file, done) => {
        if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
          done(null, true);
          return;
        }

        done(new BadRequestException('Seules les images JPEG, PNG ou WebP sont acceptées.'), false);
      },
    }),
  )
  uploadPhotos(
    @Param('id', ParseIntPipe) id: number,
    @Query('token') token: string,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    return this.guestService.uploadPhotos(id, token, files);
  }

  // ==========================================================
  // 8c. REPORT A PROBLEM (P1-04)
  // POST /guest/interventions/:id/problems?token=RAW_TOKEN
  // Opens a complaint. Texts are capped; 3 a day and 5 in all per request.
  // ==========================================================

  @UseGuards(RateLimitGuard)
  @RateLimit({ name: 'guest-problems', limit: 10, windowMs: 60 * 60_000 })
  @Post('interventions/:id/problems')
  reportProblem(
    @Param('id', ParseIntPipe) id: number,
    @Query('token') token: string,
    @Body() dto: GuestProblemReportDto,
  ) {
    return this.guestService.reportProblem(id, token, dto);
  }

  // ==========================================================
  // 9. REQUEST ACCOUNT ACTIVATION
  // POST /guest/account/request-activation
  // ==========================================================

  @UseGuards(RateLimitGuard)
  @RateLimit({ name: 'guest-request-activation', limit: 5, windowMs: 15 * 60_000 })
  @Post('account/request-activation')
  requestAccountActivation(@Body() dto: RequestGuestActivationDto, @Ip() ip: string) {
    // The client address is part of the quota: one visitor cannot use up the messages an
    // address or a number may receive and keep its real owner out.
    return this.guestService.requestAccountActivation(dto, ip || 'unknown');
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
