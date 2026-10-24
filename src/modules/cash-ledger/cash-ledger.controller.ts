import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';

import { CashLedgerService } from './cash-ledger.service';
import { CollectCashDto, LedgerQueryDto, RecordAdjustmentDto, RecordRemittanceDto } from './dto/cash-ledger.dto';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

import { Role } from '../../../generated/prisma/client';

/**
 * The cash an artisan holds for the platform (P2-02).
 *
 * The artisan declares the cash they take and reads their own ledger; the administrators and the accountant read every
 * ledger and record what the artisans hand over and what has to be put right.
 */
@Controller('cash-ledger')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CashLedgerController {
  constructor(private readonly service: CashLedgerService) {}

  /**
   * The artisan of the job says how much cash the customer gave them.
   *
   * POST /cash-ledger/interventions/:interventionId/collect-cash
   */
  @Roles(Role.ARTISAN)
  @Post('interventions/:interventionId/collect-cash')
  collectCash(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('interventionId', ParseIntPipe) interventionId: number,
    @Body() dto: CollectCashDto,
  ) {
    return this.service.collectCash(userId, role, interventionId, dto);
  }

  /**
   * What is left to take on a mission of the artisan, and whether they may take it now (the cash screen of the app).
   *
   * GET /cash-ledger/interventions/:interventionId/position
   */
  @Roles(Role.ARTISAN)
  @Get('interventions/:interventionId/position')
  position(@CurrentUser('id') userId: number, @CurrentUser('role') role: Role, @Param('interventionId', ParseIntPipe) interventionId: number) {
    return this.service.getCashPosition(userId, role, interventionId);
  }

  /**
   * The artisan's own balance and lines.
   *
   * GET /cash-ledger/mine
   */
  @Roles(Role.ARTISAN)
  @Get('mine')
  mine(@CurrentUser('id') userId: number, @CurrentUser('role') role: Role, @Query() query: LedgerQueryDto) {
    return this.service.getMyLedger(userId, role, query);
  }

  /**
   * Every artisan who holds cash or owes commission.
   *
   * GET /cash-ledger/balances
   */
  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.ACCOUNTANT)
  @Get('balances')
  balances(@CurrentUser('role') role: Role) {
    return this.service.listBalances(role);
  }

  /**
   * One artisan's balance and lines.
   *
   * GET /cash-ledger/artisans/:artisanId
   */
  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.ACCOUNTANT)
  @Get('artisans/:artisanId')
  artisanLedger(@CurrentUser('role') role: Role, @Param('artisanId', ParseIntPipe) artisanId: number, @Query() query: LedgerQueryDto) {
    return this.service.getArtisanLedger(role, artisanId, query);
  }

  /**
   * The artisan has paid commission to the platform.
   *
   * POST /cash-ledger/artisans/:artisanId/remittances
   */
  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.ACCOUNTANT)
  @Post('artisans/:artisanId/remittances')
  recordRemittance(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('artisanId', ParseIntPipe) artisanId: number,
    @Body() dto: RecordRemittanceDto,
  ) {
    return this.service.recordRemittance(userId, role, artisanId, dto);
  }

  /**
   * A figure of the ledger is put right, with the reason.
   *
   * POST /cash-ledger/artisans/:artisanId/adjustments
   */
  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.ACCOUNTANT)
  @Post('artisans/:artisanId/adjustments')
  recordAdjustment(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('artisanId', ParseIntPipe) artisanId: number,
    @Body() dto: RecordAdjustmentDto,
  ) {
    return this.service.recordAdjustment(userId, role, artisanId, dto);
  }
}
