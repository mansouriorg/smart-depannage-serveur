import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { PaymentsService } from './payments.service';
import { CreateManualPaymentDto } from './dto/create-manual-payment.dto';
import { CancelPaymentDto, ConfirmPaymentDto, FailPaymentDto, RefundPaymentDto } from './dto/payment.dto';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

import {
  PaymentMethod,
  PaymentStatus,
  Role,
} from '../../../generated/prisma/client';

@Controller('payments')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PaymentsController {
  constructor(private readonly service: PaymentsService) {}

  // ==========================================================
  // 1. CLIENT - CREATE PAYMENT REQUEST
  // Cash / bank transfer / online placeholder
  // ==========================================================

  /**
   * Client creates a payment request for one of his interventions.
   *
   * POST /payments/interventions/:interventionId
   */
  @Roles(Role.CLIENT)
  @Post('interventions/:interventionId')
  createClientPaymentRequest(
    @CurrentUser('id') userId: number,
    @Param('interventionId', ParseIntPipe) interventionId: number,
    @Body() dto: CreateManualPaymentDto,
  ) {
    return this.service.createClientPaymentRequest(
      userId,
      interventionId,
      dto,
    );
  }

  // ==========================================================
  // 2. ADMIN - CREATE MANUAL PAYMENT
  // Useful from admin dashboard for cash / bank transfer
  // ==========================================================

  /**
   * Admin creates a manual payment directly.
   *
   * POST /payments/admin/interventions/:interventionId
   */
  @Roles(
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
    Role.ACCOUNTANT,
  )
  @Post('admin/interventions/:interventionId')
  createAdminManualPayment(
    @CurrentUser('id') adminId: number,
    @Param('interventionId', ParseIntPipe) interventionId: number,
    @Body() dto: CreateManualPaymentDto,
  ) {
    return this.service.createAdminManualPayment(
      adminId,
      interventionId,
      dto,
    );
  }

  // ==========================================================
  // 3. CLIENT - PAYMENTS FOR ONE INTERVENTION
  // ==========================================================

  /**
   * Client views payments for one of his interventions.
   *
   * GET /payments/interventions/:interventionId
   */
  @Roles(Role.CLIENT)
  @Get('interventions/:interventionId')
  findForClient(
    @CurrentUser('id') userId: number,
    @Param('interventionId', ParseIntPipe) interventionId: number,
  ) {
    return this.service.findForClient(userId, interventionId);
  }

  // ==========================================================
  // 4. ADMIN - LIST PAYMENTS
  // Must stay before GET /payments/:paymentId
  // ==========================================================

  /**
   * Admin / accountant list payments.
   *
   * GET /payments/admin/all
   * GET /payments/admin/all?status=PAID
   * GET /payments/admin/all?method=CASH
   * GET /payments/admin/all?interventionId=12
   */
  @Roles(
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
    Role.ACCOUNTANT,
  )
  @Get('admin/all')
  findAllAdmin(
    @Query('status') status?: PaymentStatus,
    @Query('method') method?: PaymentMethod,
    @Query('interventionId') interventionId?: string,
  ) {
    return this.service.findAllAdmin({
      status,
      method,
      interventionId: interventionId ? Number(interventionId) : undefined,
    });
  }

  // ==========================================================
  // 5. ADMIN / ACCOUNTANT - CONFIRM PAYMENT
  // ==========================================================

  /**
   * Admin manually confirms payment.
   *
   * PATCH /payments/:paymentId/confirm
   */
  @Roles(
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
    Role.ACCOUNTANT,
  )
  @Patch(':paymentId/confirm')
  confirm(
    @CurrentUser('id') adminId: number,
    @Param('paymentId', ParseIntPipe) paymentId: number,
    @Body() dto: ConfirmPaymentDto,
  ) {
    return this.service.confirm(paymentId, adminId, dto);
  }

  // ==========================================================
  // 6. ADMIN / ACCOUNTANT - MARK PAYMENT AS FAILED
  // ==========================================================

  /**
   * Admin marks payment as failed.
   *
   * PATCH /payments/:paymentId/fail
   */
  @Roles(
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
    Role.ACCOUNTANT,
  )
  @Patch(':paymentId/fail')
  fail(
    @CurrentUser('id') adminId: number,
    @Param('paymentId', ParseIntPipe) paymentId: number,
    @Body() dto: FailPaymentDto,
  ) {
    return this.service.fail(paymentId, adminId, dto);
  }

  // ==========================================================
  // 7. ADMIN / ACCOUNTANT - CANCEL PAYMENT
  // ==========================================================

  /**
   * Admin cancels pending / awaiting / failed payment.
   *
   * PATCH /payments/:paymentId/cancel
   */
  @Roles(
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
    Role.ACCOUNTANT,
  )
  @Patch(':paymentId/cancel')
  cancel(
    @CurrentUser('id') adminId: number,
    @Param('paymentId', ParseIntPipe) paymentId: number,
    @Body() dto: CancelPaymentDto,
  ) {
    return this.service.cancel(paymentId, adminId, dto);
  }

  // ==========================================================
  // 8. ADMIN / ACCOUNTANT - REFUND PAYMENT
  // Full or partial refund
  // ==========================================================

  /**
   * Admin refunds payment.
   *
   * PATCH /payments/:paymentId/refund
   *
   * Body examples:
   * {
   *   "reason": "Remboursement total"
   * }
   *
   * {
   *   "amount": 50,
   *   "reason": "Remboursement partiel"
   * }
   *
   * No amount refunds what is left of the payment.
   */
  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.ACCOUNTANT)
  @Patch(':paymentId/refund')
  refund(
    @CurrentUser('id') adminId: number,
    @Param('paymentId', ParseIntPipe) paymentId: number,
    @Body() dto: RefundPaymentDto,
  ) {
    return this.service.refund(paymentId, adminId, dto);
  }

  // ==========================================================
  // 9. RECEIPT - GENERATE RECEIPT DATA
  // No external PDF generator for now
  // ==========================================================

  /**
   * Generate receipt data.
   *
   * GET /payments/:paymentId/receipt
   */
  @Roles(
    Role.CLIENT,
    Role.ARTISAN,
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
    Role.ACCOUNTANT,
  )
  @Get(':paymentId/receipt')
  generateReceipt(
    @CurrentUser() user: { id: number; role: Role },
    @Param('paymentId', ParseIntPipe) paymentId: number,
  ) {
    return this.service.generateReceipt(paymentId, user);
  }

  // ==========================================================
  // 10. RECEIPT - SET RECEIPT PDF URL LATER
  // ==========================================================

  /**
   * Attach receipt PDF URL later.
   *
   * PATCH /payments/:paymentId/receipt-url
   *
   * Body:
   * {
   *   "receiptUrl": "/uploads/receipts/receipt-1.pdf"
   * }
   */
  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.ACCOUNTANT)
  @Patch(':paymentId/receipt-url')
  setReceiptUrl(
    @Param('paymentId', ParseIntPipe) paymentId: number,
    @Body('receiptUrl') receiptUrl: string,
  ) {
    return this.service.setReceiptUrl(paymentId, receiptUrl);
  }

  // ==========================================================
  // 11. LINK PAYMENT TO INVOICE
  // ==========================================================

  /**
   * Link payment to invoice.
   *
   * PATCH /payments/:paymentId/invoice/:invoiceId
   */
  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.ACCOUNTANT)
  @Patch(':paymentId/invoice/:invoiceId')
  linkToInvoice(
    @Param('paymentId', ParseIntPipe) paymentId: number,
    @Param('invoiceId', ParseIntPipe) invoiceId: number,
  ) {
    return this.service.linkToInvoice(paymentId, invoiceId);
  }

  // ==========================================================
  // 12. PAYMENT DETAIL
  // Must stay after all specific routes
  // ==========================================================

  /**
   * Payment detail.
   *
   * GET /payments/:paymentId
   */
  @Roles(
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
    Role.ACCOUNTANT,
  )
  @Get(':paymentId')
  findOne(@Param('paymentId', ParseIntPipe) paymentId: number) {
    return this.service.findOne(paymentId);
  }
}
