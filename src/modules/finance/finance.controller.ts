import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';

import type { Response } from 'express';

import { Role } from '../../../generated/prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Permission } from '../../common/auth/permissions';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { FinanceInvoicesQueryDto, FinancePaymentsExportQueryDto, FinancePaymentsQueryDto, FinancePeriodQueryDto } from './dto/finance.dto';
import { FinanceService } from './finance.service';

/**
 * The finance console (P2-08): what the people who handle money read. Reading only: the actions stay on the payments, invoices,
 * business and cash-ledger routes.
 */
@Controller('finance')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class FinanceController {
  constructor(private readonly service: FinanceService) {}

  /**
   * The totals of a period: money received and given back by day, what waits, invoices and credit notes, refunds due, cash, payouts.
   *
   * GET /finance/summary?from=2026-10-19&to=2026-10-25
   */
  @RequirePermission(Permission.FINANCE_READ)
  @Get('summary')
  summary(@CurrentUser('role') role: Role, @Query() query: FinancePeriodQueryDto) {
    return this.service.summary(role, query);
  }

  /**
   * Payments: the ones waiting for the team, the money received, the money given back.
   *
   * GET /finance/payments?view=awaiting&method=CASH&search=Ben
   */
  @RequirePermission(Permission.FINANCE_READ)
  @Get('payments')
  payments(@CurrentUser('role') role: Role, @Query() query: FinancePaymentsQueryDto) {
    return this.service.listPayments(role, query);
  }

  /**
   * The payments of a filter as a CSV for a spreadsheet.
   *
   * GET /finance/payments/export?view=received&from=2026-10-19&to=2026-10-25
   */
  @RequirePermission(Permission.FINANCE_READ)
  @Get('payments/export')
  async exportPayments(@CurrentUser('role') role: Role, @Query() query: FinancePaymentsExportQueryDto, @Res() res: Response) {
    const file = await this.service.exportPayments(role, query);

    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.send(file.buffer);
  }

  /**
   * Invoices with their credit notes and what is left to pay.
   *
   * GET /finance/invoices?view=unpaid
   */
  @RequirePermission(Permission.FINANCE_READ)
  @Get('invoices')
  invoices(@CurrentUser('role') role: Role, @Query() query: FinanceInvoicesQueryDto) {
    return this.service.listInvoices(role, query);
  }

  /**
   * Jobs where a credit note leaves the customer having paid more than is owed.
   *
   * GET /finance/refunds-due
   */
  @RequirePermission(Permission.FINANCE_READ)
  @Get('refunds-due')
  refundsDue(@CurrentUser('role') role: Role) {
    return this.service.refundsDue(role);
  }
}
