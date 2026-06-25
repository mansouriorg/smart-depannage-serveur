import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';

import { Response } from 'express';

import { BusinessService } from './business.service';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

import { Role } from '../../../generated/prisma/client';

import {
  BusinessDateRangeQueryDto,
  CalculateInterventionFinancialsDto,
  CreateMonthlyReportDto,
  CreatePayoutDto,
  ExportQueryDto,
  MarkPayoutPaidDto,
} from './dto/business.dto';

@Controller('business')
@UseGuards(JwtAuthGuard)
export class BusinessController {
  constructor(private readonly service: BusinessService) {}

  private sendFile(
    res: Response,
    file: {
      filename: string;
      contentType: string;
      buffer: Buffer;
    },
  ) {
    res.setHeader('Content-Type', file.contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${file.filename}"`,
    );
    res.send(file.buffer);
  }

  // ==========================================================
  // Intervention financials
  // ==========================================================

  /**
   * POST /business/interventions/:interventionId/financials
   */
  @Post('interventions/:interventionId/financials')
  calculateInterventionFinancials(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('interventionId', ParseIntPipe) interventionId: number,
    @Body() dto: CalculateInterventionFinancialsDto,
  ) {
    return this.service.calculateInterventionFinancials(
      userId,
      role,
      interventionId,
      dto,
    );
  }

  /**
   * GET /business/interventions/:interventionId/financials
   */
  @Get('interventions/:interventionId/financials')
  getInterventionFinancials(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('interventionId', ParseIntPipe) interventionId: number,
  ) {
    return this.service.getInterventionFinancials(
      userId,
      role,
      interventionId,
    );
  }

  // ==========================================================
  // Revenue dashboard
  // ==========================================================

  /**
   * GET /business/dashboard?from=2026-06-01&to=2026-06-30
   */
  @Get('dashboard')
  revenueDashboard(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Query() query: BusinessDateRangeQueryDto,
  ) {
    return this.service.revenueDashboard(userId, role, query);
  }

  /**
   * GET /business/financials?from=2026-06-01&to=2026-06-30
   */
  @Get('financials')
  listFinancials(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Query() query: BusinessDateRangeQueryDto,
  ) {
    return this.service.listFinancials(userId, role, query);
  }

  // ==========================================================
  // Monthly reports
  // ==========================================================

  /**
   * POST /business/reports/monthly
   */
  @Post('reports/monthly')
  createMonthlyReport(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Body() dto: CreateMonthlyReportDto,
  ) {
    return this.service.createMonthlyReport(userId, role, dto);
  }

  /**
   * GET /business/reports/monthly
   */
  @Get('reports/monthly')
  listMonthlyReports(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
  ) {
    return this.service.listMonthlyReports(userId, role);
  }

  // ==========================================================
  // Artisan payouts
  // ==========================================================

  /**
   * POST /business/payouts
   */
  @Post('payouts')
  createArtisanPayout(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Body() dto: CreatePayoutDto,
  ) {
    return this.service.createArtisanPayout(userId, role, dto);
  }

  /**
   * GET /business/payouts
   */
  @Get('payouts')
  listPayouts(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
  ) {
    return this.service.listPayouts(userId, role);
  }

  /**
   * PATCH /business/payouts/:payoutId/paid
   */
  @Patch('payouts/:payoutId/paid')
  markPayoutPaid(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('payoutId', ParseIntPipe) payoutId: number,
    @Body() dto: MarkPayoutPaidDto,
  ) {
    return this.service.markPayoutPaid(
      userId,
      role,
      payoutId,
      dto,
    );
  }

  // ==========================================================
  // Exports
  // ==========================================================

  /**
   * GET /business/exports/revenue/csv?from=2026-06-01&to=2026-06-30
   */
  @Get('exports/revenue/csv')
  async exportRevenueCsv(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Query() query: ExportQueryDto,
    @Res() res: Response,
  ) {
    const file = await this.service.exportRevenueCsv(
      userId,
      role,
      query,
    );

    return this.sendFile(res, file);
  }

  /**
   * GET /business/exports/revenue/pdf?from=2026-06-01&to=2026-06-30
   */
  @Get('exports/revenue/pdf')
  async exportRevenuePdf(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Query() query: ExportQueryDto,
    @Res() res: Response,
  ) {
    const file = await this.service.exportRevenuePdf(
      userId,
      role,
      query,
    );

    return this.sendFile(res, file);
  }

  /**
   * GET /business/exports/accounting?from=2026-06-01&to=2026-06-30
   */
  @Get('exports/accounting')
  async createAccountingExport(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Query() query: ExportQueryDto,
    @Res() res: Response,
  ) {
    const result = await this.service.createAccountingExport(
      userId,
      role,
      query,
    );

    return this.sendFile(res, result.file);
  }
}