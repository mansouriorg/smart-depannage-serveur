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

import { InvoicesService } from './invoices.service';
import { CreateInvoiceDto } from './dto/create-invoice.dto';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

import {
  InvoiceStatus,
  PaymentStatus,
  Role,
} from '../../../generated/prisma/client';

type AuthenticatedUser = {
  id: number;
  role: Role;
};

type SendInvoiceEmailBody = {
  email?: string;
  message?: string;
};

type CancelInvoiceBody = {
  reason?: string;
};

type SetInvoicePdfBody = {
  pdfUrl: string;
};

type ExportInvoicesQuery = {
  status?: InvoiceStatus;
  paymentStatus?: PaymentStatus;
  dateFrom?: string;
  dateTo?: string;
  format?: 'json' | 'csv';
};

@Controller('invoices')
@UseGuards(JwtAuthGuard, RolesGuard)
export class InvoicesController {
  constructor(private readonly service: InvoicesService) {}

  // ==========================================================
  // 1. ADMIN - CREATE / GENERATE INVOICE FOR INTERVENTION
  // Keeps your existing route
  // ==========================================================

  /**
   * Create invoice for an intervention.
   *
   * POST /invoices/interventions/:interventionId
   */
  @Roles(
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
    Role.ACCOUNTANT,
  )
  @Post('interventions/:interventionId')
  createForIntervention(
    @CurrentUser('id') adminId: number,
    @Param('interventionId', ParseIntPipe) interventionId: number,
    @Body() dto: CreateInvoiceDto,
  ) {
    return this.service.createForIntervention(interventionId, adminId, dto);
  }

  // ==========================================================
  // 2. ADMIN - GENERATE INVOICE ALTERNATIVE ROUTE
  // Useful if frontend sends interventionId in body
  // ==========================================================

  /**
   * Generate invoice using body.interventionId.
   *
   * POST /invoices/generate
   *
   * Body:
   * {
   *   "interventionId": 12,
   *   "amountHT": 120,
   *   "taxRate": 20,
   *   "notes": "Merci pour votre confiance."
   * }
   */
  @Roles(
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
    Role.ACCOUNTANT,
  )
  @Post('generate')
  generateInvoice(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateInvoiceDto & { interventionId: number },
  ) {
    return this.service.generateInvoice(user, dto);
  }

  // ==========================================================
  // 3. CLIENT - MY INVOICES
  // Keeps your existing route
  // ==========================================================

  /**
   * Client lists his invoices.
   *
   * GET /invoices/mine
   */
  @Roles(Role.CLIENT)
  @Get('mine')
  findMine(@CurrentUser('id') userId: number) {
    return this.service.findMine(userId);
  }

  // ==========================================================
  // 4. ADMIN - EXPORT INVOICES
  // Must stay before GET /invoices/:invoiceId
  // ==========================================================

  /**
   * Export invoices as JSON or CSV.
   *
   * GET /invoices/export
   * GET /invoices/export?format=csv
   * GET /invoices/export?status=ISSUED
   * GET /invoices/export?paymentStatus=PAID
   * GET /invoices/export?dateFrom=2026-01-01&dateTo=2026-12-31
   */
  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.ACCOUNTANT)
  @Get('export')
  exportInvoices(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ExportInvoicesQuery,
  ) {
    return this.service.exportInvoices(user, query);
  }

  // ==========================================================
  // 5. CLIENT / ADMIN / ARTISAN - INVOICE BY INTERVENTION
  // Must stay before GET /invoices/:invoiceId
  // ==========================================================

  /**
   * Find invoice by intervention.
   *
   * GET /invoices/intervention/:interventionId
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
  @Get('intervention/:interventionId')
  findByIntervention(
    @CurrentUser() user: AuthenticatedUser,
    @Param('interventionId', ParseIntPipe) interventionId: number,
  ) {
    return this.service.findByIntervention(user, interventionId);
  }

  // ==========================================================
  // 6. CLIENT - OLD DETAIL ROUTE COMPATIBILITY
  // Keeps your existing behavior for clients
  // ==========================================================

  /**
   * Client invoice detail.
   *
   * GET /invoices/client/:invoiceId
   */
  @Roles(Role.CLIENT)
  @Get('client/:invoiceId')
  findOneForClient(
    @CurrentUser('id') userId: number,
    @Param('invoiceId', ParseIntPipe) invoiceId: number,
  ) {
    return this.service.findOneForClient(userId, invoiceId);
  }

  // ==========================================================
  // 7. CLIENT - OLD DOWNLOAD ROUTE COMPATIBILITY
  // ==========================================================

  /**
   * Client invoice download.
   *
   * GET /invoices/client/:invoiceId/download
   */
  @Roles(Role.CLIENT)
  @Get('client/:invoiceId/download')
  downloadForClient(
    @CurrentUser('id') userId: number,
    @Param('invoiceId', ParseIntPipe) invoiceId: number,
  ) {
    return this.service.downloadForClient(userId, invoiceId);
  }

  // ==========================================================
  // 8. ADMIN - SET PDF URL
  // ==========================================================

  /**
   * Attach or update invoice PDF URL.
   *
   * PATCH /invoices/:invoiceId/pdf
   *
   * Body:
   * {
   *   "pdfUrl": "/uploads/invoices/invoice-12.pdf"
   * }
   */
  @Roles(
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
    Role.ACCOUNTANT,
  )
  @Patch(':invoiceId/pdf')
  setPdfUrl(
    @CurrentUser() user: AuthenticatedUser,
    @Param('invoiceId', ParseIntPipe) invoiceId: number,
    @Body() dto: SetInvoicePdfBody,
  ) {
    return this.service.setPdfUrl(user, invoiceId, dto);
  }

  // ==========================================================
  // 9. ADMIN - SEND INVOICE BY EMAIL
  // ==========================================================

  /**
   * Send invoice by email.
   *
   * POST /invoices/:invoiceId/send-email
   *
   * Body:
   * {
   *   "email": "client@example.com",
   *   "message": "Bonjour, votre facture est disponible."
   * }
   */
  @Roles(
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
    Role.ACCOUNTANT,
  )
  @Post(':invoiceId/send-email')
  sendInvoiceByEmail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('invoiceId', ParseIntPipe) invoiceId: number,
    @Body() dto: SendInvoiceEmailBody,
  ) {
    return this.service.sendInvoiceByEmail(user, invoiceId, dto);
  }

  // ==========================================================
  // 10. ADMIN - CANCEL INVOICE
  // ==========================================================

  /**
   * Cancel invoice.
   *
   * PATCH /invoices/:invoiceId/cancel
   *
   * Body:
   * {
   *   "reason": "Erreur de facturation"
   * }
   */
  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.ACCOUNTANT)
  @Patch(':invoiceId/cancel')
  cancelInvoice(
    @CurrentUser() user: AuthenticatedUser,
    @Param('invoiceId', ParseIntPipe) invoiceId: number,
    @Body() dto: CancelInvoiceBody,
  ) {
    return this.service.cancelInvoice(user, invoiceId, dto);
  }

  // ==========================================================
  // 11. CLIENT / ADMIN / ARTISAN - GENERAL DOWNLOAD
  // Must stay before GET /invoices/:invoiceId
  // ==========================================================

  /**
   * Download invoice or get invoice data if PDF is not generated.
   *
   * GET /invoices/:invoiceId/download
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
  @Get(':invoiceId/download')
  download(
    @CurrentUser() user: AuthenticatedUser,
    @Param('invoiceId', ParseIntPipe) invoiceId: number,
  ) {
    return this.service.downloadInvoice(user, invoiceId);
  }

  // ==========================================================
  // 12. CLIENT / ADMIN / ARTISAN - GENERAL DETAIL
  // Must stay after all specific routes
  // ==========================================================

  /**
   * Invoice detail.
   *
   * GET /invoices/:invoiceId
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
  @Get(':invoiceId')
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('invoiceId', ParseIntPipe) invoiceId: number,
  ) {
    return this.service.findOne(user, invoiceId);
  }
}