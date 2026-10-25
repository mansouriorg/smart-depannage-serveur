import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';

import type { Response } from 'express';

import { Role } from '../../../generated/prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { FinanceInvoicesQueryDto, FinancePaymentsExportQueryDto, FinancePaymentsQueryDto, FinancePeriodQueryDto } from './dto/finance.dto';
import { FinanceService } from './finance.service';

/**
 * The finance console (P2-08): what the people who handle money read. Reading only: the actions stay on the payments, invoices,
 * business and cash-ledger routes.
 */
@Controller('finance')
@UseGuards(JwtAuthGuard, RolesGuard)
export class FinanceController {
  constructor(private readonly service: FinanceService) {}

  /**
   * The totals of a period: money received and given back by day, what waits, invoices and credit notes, refunds due, cash, payouts.
   *
   * GET /finance/summary?from=2026-10-19&to=2026-10-25
   */
  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.ACCOUNTANT)
  @Get('summary')
  summary(@CurrentUser('role') role: Role, @Query() query: FinancePeriodQueryDto) {
    return this.service.summary(role, query);
  }

  /**
   * Payments: the ones waiting for the team, the money received, the money given back.
   *
   * GET /finance/payments?view=awaiting&method=CASH&search=Ben
   */
  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.ACCOUNTANT)
  @Get('payments')
  payments(@CurrentUser('role') role: Role, @Query() query: FinancePaymentsQueryDto) {
    return this.service.listPayments(role, query);
  }

  /**
   * The payments of a filter as a CSV for a spreadsheet.
   *
   * GET /finance/payments/export?view=received&from=2026-10-19&to=2026-10-25
   */
  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.ACCOUNTANT)
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
  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.ACCOUNTANT)
  @Get('invoices')
  invoices(@CurrentUser('role') role: Role, @Query() query: FinanceInvoicesQueryDto) {
    return this.service.listInvoices(role, query);
  }

  /**
   * Jobs where a credit note leaves the customer having paid more than is owed.
   *
   * GET /finance/refunds-due
   */
  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.ACCOUNTANT)
  @Get('refunds-due')
  refundsDue(@CurrentUser('role') role: Role) {
    return this.service.refundsDue(role);
  }
}
