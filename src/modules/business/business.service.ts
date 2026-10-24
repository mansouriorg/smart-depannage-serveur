import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  AccountingExportStatus,
  BusinessExportFormat,
  PayoutStatus,
  Prisma,
  Role,
} from '../../../generated/prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { compareMoney, divideMoney, formatMoney, money, ratioPercent, subtractMoney, sumMoneyOf, toMoneyString } from '../../common/money/money';
import { decimalsToNumbers } from '../../common/money/money-numbers';
import { currencyCode } from '../../common/locale/locale';
import { businessDateOf, businessMonthRange, instantOf, startOfBusinessMonth } from '../../common/locale/business-time';
import { lockJob, lockPayouts } from '../assignment/artisan-lock';
import { syncFinancials } from '../payments/financials-ops';
import { PayoutDecision, payoutDecisions } from './payout-holds';

import {
  BusinessDateRangeQueryDto,
  CalculateInterventionFinancialsDto,
  CreateMonthlyReportDto,
  CreatePayoutDto,
  ExportQueryDto,
  MarkPayoutPaidDto,
  PayoutPreviewQueryDto,
} from './dto/business.dto';

@Injectable()
export class BusinessService {
  constructor(private readonly prisma: PrismaService) {}

  // ==========================================================
  // Helpers
  // ==========================================================

  private isStaff(role: Role): boolean {
    const staffRoles: Role[] = [
      Role.ADMIN,
      Role.SUPER_ADMIN,
      Role.SUPPORT,
      Role.DISPATCHER,
      Role.ACCOUNTANT,
    ];

    return staffRoles.includes(role);
  }

  private assertStaff(role: Role) {
    if (!this.isStaff(role)) {
      throw new ForbiddenException('Accès réservé à l’administration.');
    }
  }

  private parseDateRange(from?: string, to?: string) {
    const end = to ? new Date(to) : new Date();
    const start = from
      ? new Date(from)
      : startOfBusinessMonth(end);

    if (
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime()) ||
      start > end
    ) {
      throw new BadRequestException('Période invalide.');
    }

    return {
      from: start,
      to: end,
    };
  }

  /** The month on the clock of the business: from its first instant to its last millisecond. */
  private monthRange(year: number, month: number) {
    return businessMonthRange(year, month);
  }

  private financialInclude() {
    return {
      intervention: {
        select: {
          id: true,
          description: true,
          address: true,
          serviceType: true,
          status: true,
          urgency: true,
          clientId: true,
          artisanId: true,
          createdAt: true,
          paidAt: true,
          invoiceSentAt: true,
          workCompletedAt: true,
          client: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
            },
          },
          artisan: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
            },
          },
        },
      },
    } satisfies Prisma.InterventionFinancialsInclude;
  }

  private async getInterventionOrFail(interventionId: number) {
    const intervention = await this.prisma.intervention.findUnique({
      where: {
        id: interventionId,
      },
      include: {
        invoices: true,
        payments: true,
        client: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
          },
        },
        artisan: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
          },
        },
      },
    });

    if (!intervention) {
      throw new NotFoundException('Intervention introuvable.');
    }

    return intervention;
  }

  private csvCell(value: unknown): string {
    const raw = value === null || value === undefined ? '' : String(value);

    if (/[",\n\r]/.test(raw)) {
      return `"${raw.replace(/"/g, '""')}"`;
    }

    return raw;
  }

  private buildCsv(headers: string[], rows: unknown[][]): string {
    return [
      headers.map((header) => this.csvCell(header)).join(','),
      ...rows.map((row) => row.map((cell) => this.csvCell(cell)).join(',')),
    ].join('\n');
  }

  private escapePdfText(value: string): string {
    return value
      .replace(/\\/g, '\\\\')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)');
  }

  private buildSimplePdfBuffer(title: string, lines: string[]): Buffer {
    const safeTitle = this.escapePdfText(title);

    const limitedLines = lines
      .slice(0, 42)
      .map((line) => this.escapePdfText(line));

    const textOperations = [
      'BT',
      '/F1 16 Tf',
      '50 790 Td',
      `(${safeTitle}) Tj`,
      '/F1 10 Tf',
      ...limitedLines.flatMap((line) => [
        '0 -18 Td',
        `(${line}) Tj`,
      ]),
      'ET',
    ].join('\n');

    const stream = textOperations;
    const streamLength = Buffer.byteLength(stream, 'latin1');

    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      `<< /Length ${streamLength} >>\nstream\n${stream}\nendstream`,
    ];

    let pdf = '%PDF-1.4\n';
    const offsets: number[] = [];

    objects.forEach((object, index) => {
      offsets.push(Buffer.byteLength(pdf, 'latin1'));
      pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    });

    const xrefStart = Buffer.byteLength(pdf, 'latin1');

    pdf += `xref\n0 ${objects.length + 1}\n`;
    pdf += '0000000000 65535 f \n';

    offsets.forEach((offset) => {
      pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
    });

    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
    pdf += `startxref\n${xrefStart}\n%%EOF`;

    return Buffer.from(pdf, 'latin1');
  }

  private toJsonValue(value: unknown): Prisma.InputJsonValue {
    // A Decimal would be written as a text: the amounts of a saved report are numbers.
    return JSON.parse(JSON.stringify(decimalsToNumbers(value))) as Prisma.InputJsonValue;
  }

  // ==========================================================
  // Intervention financials
  // ==========================================================

  /**
   * Works the financials of a job out again from its confirmed payments (they are also worked out by themselves whenever a
   * payment is confirmed or refunded). What the back office can still decide is the commission rate, the payment provider's fee
   * and the notes; the amounts come from the payments.
   *
   * POST /business/interventions/:interventionId/financials
   */
  async calculateInterventionFinancials(
    userId: number,
    role: Role,
    interventionId: number,
    dto: CalculateInterventionFinancialsDto,
  ) {
    this.assertStaff(role);

    const intervention = await this.getInterventionOrFail(interventionId);

    if (!intervention.artisanId) {
      throw new BadRequestException(
        'Impossible de calculer le payout: aucun artisan assigné.',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // The same lock as a confirmation or a refund: the payments do not change while the figures are worked out.
      await lockJob(tx, interventionId);

      const worked = await syncFinancials(
        tx,
        interventionId,
        { userId },
        { commissionRate: dto.commissionRate, paymentProviderFee: dto.paymentProviderFee, notes: dto.notes },
      );

      if (!worked) {
        throw new BadRequestException(
          'Aucun paiement confirmé: les montants sont calculés à partir des paiements confirmés de l’intervention.',
        );
      }

      return tx.interventionFinancials.findUnique({
        where: { interventionId },
        include: this.financialInclude(),
      });
    });
  }

  async getInterventionFinancials(
    userId: number,
    role: Role,
    interventionId: number,
  ) {
    this.assertStaff(role);

    const financials = await this.prisma.interventionFinancials.findUnique({
      where: {
        interventionId,
      },
      include: this.financialInclude(),
    });

    if (!financials) {
      throw new NotFoundException('Financials introuvables.');
    }

    return financials;
  }

  async listFinancials(
    userId: number,
    role: Role,
    query: BusinessDateRangeQueryDto,
  ) {
    this.assertStaff(role);

    const range = this.parseDateRange(query.from, query.to);

    const where: Prisma.InterventionFinancialsWhereInput = {
      createdAt: {
        gte: range.from,
        lte: range.to,
      },
      ...(query.artisanId
        ? {
            intervention: {
              artisanId: query.artisanId,
            },
          }
        : {}),
    };

    return this.prisma.interventionFinancials.findMany({
      where,
      include: this.financialInclude(),
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  // ==========================================================
  // Revenue dashboard
  // ==========================================================

  async revenueDashboard(
    userId: number,
    role: Role,
    query: BusinessDateRangeQueryDto,
  ) {
    this.assertStaff(role);

    const range = this.parseDateRange(query.from, query.to);

    const where: Prisma.InterventionFinancialsWhereInput = {
      createdAt: {
        gte: range.from,
        lte: range.to,
      },
      ...(query.artisanId
        ? {
            intervention: {
              artisanId: query.artisanId,
            },
          }
        : {}),
    };

    const financials = await this.prisma.interventionFinancials.findMany({
      where,
      include: this.financialInclude(),
      orderBy: {
        createdAt: 'desc',
      },
    });

    const interventionCount = financials.length;

    // A job is paid when it has a payment that was confirmed (and not given back in full): not when it is only finished, or waiting for its payment.
    const paidPayments = await this.prisma.payment.findMany({
      where: {
        interventionId: { in: financials.map((item) => item.interventionId) },
        status: { in: ['PAID', 'PARTIALLY_REFUNDED'] },
      },
      select: { interventionId: true },
    });
    const paidJobs = new Set(paidPayments.map((payment) => payment.interventionId));

    const paidInterventionCount = financials.filter((item) => paidJobs.has(item.interventionId)).length;

    const refundedCount = financials.filter(
      (item) => compareMoney(item.refundAmount, 0) > 0,
    ).length;

    const totalRevenue = sumMoneyOf(financials.map((item) => item.totalPrice));

    const totalCommission = sumMoneyOf(financials.map((item) => item.platformCommission));

    const totalArtisanPayouts = sumMoneyOf(financials.map((item) => item.artisanPayout));

    const totalPaymentFees = sumMoneyOf(financials.map((item) => item.paymentProviderFee));

    const totalRefunds = sumMoneyOf(financials.map((item) => item.refundAmount));

    const netRevenue = sumMoneyOf(financials.map((item) => item.netRevenue));

    const companyMargin = sumMoneyOf(financials.map((item) => item.companyMargin));

    const averageOrderValue =
      interventionCount === 0
        ? 0
        : divideMoney(totalRevenue, interventionCount);

    const marginRate = ratioPercent(companyMargin, totalRevenue);

    return {
      period: {
        from: range.from,
        to: range.to,
      },
      filters: {
        artisanId: query.artisanId || null,
      },
      totals: {
        interventionCount,
        paidInterventionCount,
        refundedCount,
        totalRevenue,
        totalCommission,
        totalArtisanPayouts,
        totalPaymentFees,
        totalRefunds,
        netRevenue,
        companyMargin,
        averageOrderValue,
        marginRate,
      },
      latest: financials.slice(0, 10),
    };
  }

  // ==========================================================
  // Monthly reports
  // ==========================================================

  async createMonthlyReport(
    userId: number,
    role: Role,
    dto: CreateMonthlyReportDto,
  ) {
    this.assertStaff(role);

    const range = this.monthRange(dto.year, dto.month);

    const dashboard = await this.revenueDashboard(userId, role, {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
    });

    const label = `${dto.year}-${String(dto.month).padStart(2, '0')}`;

    return this.prisma.businessReport.create({
      data: {
        periodStart: range.from,
        periodEnd: range.to,
        label,
        currency: currencyCode(),

        interventionCount: dashboard.totals.interventionCount,
        paidInterventionCount: dashboard.totals.paidInterventionCount,
        refundedCount: dashboard.totals.refundedCount,

        totalRevenue: dashboard.totals.totalRevenue,
        totalCommission: dashboard.totals.totalCommission,
        totalArtisanPayouts: dashboard.totals.totalArtisanPayouts,
        totalPaymentFees: dashboard.totals.totalPaymentFees,
        totalRefunds: dashboard.totals.totalRefunds,

        netRevenue: dashboard.totals.netRevenue,
        companyMargin: dashboard.totals.companyMargin,

        data: this.toJsonValue(dashboard),

        createdById: userId,
      },
      include: {
        createdBy: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
      },
    });
  }

  async listMonthlyReports(userId: number, role: Role) {
    this.assertStaff(role);

    return this.prisma.businessReport.findMany({
      include: {
        createdBy: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  // ==========================================================
  // Artisan payouts
  // ==========================================================

  /** The period of a payout from what was typed: a time without an offset is read on the clock of the business. */
  private payoutPeriod(dto: { periodStart: string; periodEnd: string }) {
    const periodStart = instantOf(dto.periodStart);
    const periodEnd = instantOf(dto.periodEnd);

    if (
      Number.isNaN(periodStart.getTime()) ||
      Number.isNaN(periodEnd.getTime()) ||
      periodStart > periodEnd
    ) {
      throw new BadRequestException('Période invalide.');
    }

    return { periodStart, periodEnd };
  }

  private async activeArtisanOrFail(artisanId: number) {
    const artisan = await this.prisma.user.findFirst({
      where: {
        id: artisanId,
        role: Role.ARTISAN,
        isActive: true,
        deletedAt: null,
      },
    });

    if (!artisan) {
      throw new NotFoundException('Artisan introuvable.');
    }

    return artisan;
  }

  /**
   * The jobs of the artisan in the period that no payout has taken yet (a cancelled payout takes none), split into those that
   * can be paid now, with what they pay, and those that are held back, each with its reasons (see `payout-holds`).
   */
  private async payoutCandidates(db: any, artisanId: number, periodStart: Date, periodEnd: Date) {
    const financials: any[] = await db.interventionFinancials.findMany({
      where: {
        createdAt: {
          gte: periodStart,
          lte: periodEnd,
        },
        intervention: {
          artisanId,
        },
        payoutItems: {
          none: { payout: { status: { not: PayoutStatus.CANCELLED } } },
        },
      },
      include: this.financialInclude(),
      orderBy: {
        createdAt: 'asc',
      },
    });

    const decisions = await payoutDecisions(db, artisanId, financials);
    const decisionOf = (item: any) => decisions.get(item.id) as PayoutDecision;

    return {
      free: financials.filter((item) => decisionOf(item).reasons.length === 0).map((item) => ({ financial: item, amount: decisionOf(item).amount, cashHeld: decisionOf(item).cashHeld })),
      held: financials.filter((item) => decisionOf(item).reasons.length > 0).map((item) => ({ financial: item, reasons: decisionOf(item).reasons, amount: decisionOf(item).amount })),
    };
  }

  /**
   * What a payout of this artisan for this period would pay, and what it would leave out and why. Writes nothing.
   *
   * GET /business/payouts/preview
   */
  async previewArtisanPayout(userId: number, role: Role, query: PayoutPreviewQueryDto) {
    this.assertStaff(role);

    const { periodStart, periodEnd } = this.payoutPeriod(query);
    const artisan = await this.activeArtisanOrFail(query.artisanId);
    const { free, held } = await this.payoutCandidates(this.prisma, artisan.id, periodStart, periodEnd);

    return {
      artisanId: artisan.id,
      periodStart,
      periodEnd,
      currency: currencyCode(),
      grossAmount: sumMoneyOf(free.map((item) => item.amount)),
      included: free.map(({ financial, amount, cashHeld }) => ({ financialId: financial.id, interventionId: financial.interventionId, amount, cashHeld })),
      held: held.map(({ financial, reasons, amount }) => ({
        financialId: financial.id,
        interventionId: financial.interventionId,
        amount,
        reasons,
      })),
    };
  }

  async createArtisanPayout(
    userId: number,
    role: Role,
    dto: CreatePayoutDto,
  ) {
    this.assertStaff(role);

    const { periodStart, periodEnd } = this.payoutPeriod(dto);
    const artisan = await this.activeArtisanOrFail(dto.artisanId);

    // One payout of an artisan is made at a time: two requests that both see a job as free would both pay it.
    return this.prisma.$transaction(async (tx) => {
      await lockPayouts(tx, artisan.id);

      const { free, held } = await this.payoutCandidates(tx, artisan.id, periodStart, periodEnd);

      if (!free.length) {
        throw new BadRequestException(
          held.length
            ? `Aucune intervention financière ne peut être payée maintenant: ${held.length} intervention(s) sont retenues (litige, remboursement, espèces déjà encaissées, travail non terminé ou paiement incomplet).`
            : 'Aucune intervention financière disponible pour ce payout.',
        );
      }

      const grossAmount = sumMoneyOf(free.map((item) => item.amount));

      const refundsDeducted = 0;
      const paymentProviderFees = 0;
      const netAmount = subtractMoney(subtractMoney(grossAmount, refundsDeducted), paymentProviderFees);

      return tx.artisanPayout.create({
        data: {
          artisanId: artisan.id,
          status: PayoutStatus.READY,
          periodStart,
          periodEnd,
          currency: currencyCode(),
          grossAmount,
          paymentProviderFees,
          refundsDeducted,
          netAmount,
          notes: dto.notes?.trim() || null,
          items: {
            create: free.map(({ financial, amount }) => ({
              financialId: financial.id,
              interventionId: financial.interventionId,
              amount,
            })),
          },
        },
        include: {
          artisan: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
            },
          },
          items: {
            include: {
              financial: {
                include: this.financialInclude(),
              },
            },
          },
        },
      });
    });
  }

  async listPayouts(userId: number, role: Role) {
    this.assertStaff(role);

    return this.prisma.artisanPayout.findMany({
      include: {
        artisan: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
          },
        },
        items: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  /**
   * The payout has been paid. Saying it twice changes nothing: the second call answers the payout as the first one left it
   * (same date, same reference), whether it comes a minute later or at the same moment. A payout that was cancelled or failed
   * is not paid by this call.
   */
  async markPayoutPaid(
    userId: number,
    role: Role,
    payoutId: number,
    dto: MarkPayoutPaidDto,
  ) {
    this.assertStaff(role);

    const include = {
      artisan: {
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
        },
      },
      items: true,
    };

    const payout = await this.prisma.artisanPayout.findUnique({
      where: {
        id: payoutId,
      },
    });

    if (!payout) {
      throw new NotFoundException('Payout introuvable.');
    }

    const paidAt = dto.paidAt ? instantOf(dto.paidAt) : new Date();

    if (Number.isNaN(paidAt.getTime())) {
      throw new BadRequestException('Date de paiement invalide.');
    }

    // One payout of an artisan changes at a time (the same lock as the creation of a payout and a cash collection): of two
    // requests at the same moment, the second one finds the payout already paid and answers it as the first one left it.
    return this.prisma.$transaction(async (tx) => {
      await lockPayouts(tx, payout.artisanId);

      const current = await tx.artisanPayout.findUnique({ where: { id: payoutId }, include });

      if (!current) {
        throw new NotFoundException('Payout introuvable.');
      }

      if (current.status === PayoutStatus.PAID) {
        return current;
      }

      if (current.status !== PayoutStatus.PENDING && current.status !== PayoutStatus.READY) {
        throw new ConflictException(`Ce payout est ${current.status === PayoutStatus.CANCELLED ? 'annulé' : 'en échec'}: il ne peut pas être marqué comme payé.`);
      }

      // Between its creation and now a job of the payout may have been disputed, refunded, or paid in cash (all or part of it),
      // or its share may have been calculated again: what the payout says it pays is then no longer what the job is owed. Such a
      // payout is not paid, it is cancelled and made again.
      const financials: any[] = await tx.interventionFinancials.findMany({ where: { id: { in: current.items.map((item: any) => item.financialId) } } });
      const decisions = await payoutDecisions(tx, current.artisanId, financials);
      const changed = current.items.filter((item: any) => {
        const decision = decisions.get(item.financialId);

        return !decision || decision.reasons.length > 0 || compareMoney(money(item.amount), decision.amount) !== 0;
      });

      if (changed.length > 0) {
        throw new ConflictException(
          `Ce payout ne peut pas être marqué comme payé: ${changed.length} intervention(s) ont changé depuis sa création (litige, remboursement, espèces déjà encaissées, travail non terminé, paiement incomplet ou montant). Annulez-le puis refaites-le.`,
        );
      }

      return tx.artisanPayout.update({
        where: { id: payoutId },
        data: {
          status: PayoutStatus.PAID,
          paidAt,
          paymentReference: dto.paymentReference?.trim() || null,
        },
        include,
      });
    });
  }

  /**
   * The payout is cancelled: its jobs are free again for the next one. A payout that was paid is not cancelled (what was paid
   * is put right with an adjustment of the cash ledger); a payout that is already cancelled stays as it is.
   *
   * PATCH /business/payouts/:payoutId/cancel
   */
  async cancelPayout(userId: number, role: Role, payoutId: number) {
    this.assertStaff(role);

    const include = {
      artisan: {
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
        },
      },
      items: true,
    };

    const payout = await this.prisma.artisanPayout.findUnique({ where: { id: payoutId } });

    if (!payout) {
      throw new NotFoundException('Payout introuvable.');
    }

    return this.prisma.$transaction(async (tx) => {
      await lockPayouts(tx, payout.artisanId);

      const current = await tx.artisanPayout.findUnique({ where: { id: payoutId }, include });

      if (!current) {
        throw new NotFoundException('Payout introuvable.');
      }

      if (current.status === PayoutStatus.CANCELLED) {
        return current;
      }

      if (current.status === PayoutStatus.PAID) {
        throw new ConflictException('Ce payout est déjà payé: il ne peut plus être annulé.');
      }

      return tx.artisanPayout.update({ where: { id: payoutId }, data: { status: PayoutStatus.CANCELLED }, include });
    });
  }

  // ==========================================================
  // Exports
  // ==========================================================

  async exportRevenueCsv(
    userId: number,
    role: Role,
    query: ExportQueryDto,
  ) {
    this.assertStaff(role);

    const items = await this.listFinancials(userId, role, {
      from: query.from,
      to: query.to,
    });

    const csv = this.buildCsv(
      [
        'financialId',
        'interventionId',
        'clientId',
        'artisanId',
        'serviceType',
        'status',
        'currency',
        'totalPrice',
        'artisanPayout',
        'platformCommission',
        'paymentProviderFee',
        'refundAmount',
        'netRevenue',
        'companyMargin',
        'createdAt',
      ],
      items.map((item) => [
        item.id,
        item.interventionId,
        item.intervention.clientId,
        item.intervention.artisanId,
        item.intervention.serviceType,
        item.intervention.status,
        item.currency,
        toMoneyString(item.totalPrice),
        toMoneyString(item.artisanPayout),
        toMoneyString(item.platformCommission),
        toMoneyString(item.paymentProviderFee),
        toMoneyString(item.refundAmount),
        toMoneyString(item.netRevenue),
        toMoneyString(item.companyMargin),
        item.createdAt.toISOString(),
      ]),
    );

    return {
      filename: `revenue-export-${Date.now()}.csv`,
      contentType: 'text/csv; charset=utf-8',
      buffer: Buffer.from(csv, 'utf8'),
    };
  }

  async exportRevenuePdf(
    userId: number,
    role: Role,
    query: ExportQueryDto,
  ) {
    this.assertStaff(role);

    const dashboard = await this.revenueDashboard(userId, role, {
      from: query.from,
      to: query.to,
    });

    const lines = [
      `Period: ${dashboard.period.from.toISOString()} - ${dashboard.period.to.toISOString()}`,
      `Interventions: ${dashboard.totals.interventionCount}`,
      `Paid interventions: ${dashboard.totals.paidInterventionCount}`,
      `Refunded interventions: ${dashboard.totals.refundedCount}`,
      `Total revenue: ${formatMoney(dashboard.totals.totalRevenue)}`,
      `Total commission: ${formatMoney(dashboard.totals.totalCommission)}`,
      `Artisan payouts: ${formatMoney(dashboard.totals.totalArtisanPayouts)}`,
      `Payment fees: ${formatMoney(dashboard.totals.totalPaymentFees)}`,
      `Refunds: ${formatMoney(dashboard.totals.totalRefunds)}`,
      `Net revenue: ${formatMoney(dashboard.totals.netRevenue)}`,
      `Company margin: ${formatMoney(dashboard.totals.companyMargin)}`,
      `Margin rate: ${dashboard.totals.marginRate}%`,
    ];

    return {
      filename: `revenue-report-${Date.now()}.pdf`,
      contentType: 'application/pdf',
      buffer: this.buildSimplePdfBuffer('Revenue Report', lines),
    };
  }

  async createAccountingExport(
    userId: number,
    role: Role,
    query: ExportQueryDto,
  ) {
    this.assertStaff(role);

    const items = await this.listFinancials(userId, role, {
      from: query.from,
      to: query.to,
    });

    const rows = items.flatMap((item) => {
      // The day of the entry is the day on the clock of the business.
      const date = businessDateOf(item.createdAt);
      const interventionLabel = `Intervention #${item.interventionId}`;

      return [
        {
          date,
          account: 'CLIENT_REVENUE',
          label: `${interventionLabel} - Client payment`,
          debit: money(item.totalPrice),
          credit: 0,
          interventionId: item.interventionId,
        },
        {
          date,
          account: 'ARTISAN_PAYABLE',
          label: `${interventionLabel} - Artisan payout`,
          debit: 0,
          credit: money(item.artisanPayout),
          interventionId: item.interventionId,
        },
        {
          date,
          account: 'PLATFORM_COMMISSION',
          label: `${interventionLabel} - Platform commission`,
          debit: 0,
          credit: money(item.platformCommission),
          interventionId: item.interventionId,
        },
        {
          date,
          account: 'PAYMENT_FEES',
          label: `${interventionLabel} - Payment provider fee`,
          debit: money(item.paymentProviderFee),
          credit: 0,
          interventionId: item.interventionId,
        },
        {
          date,
          account: 'REFUNDS',
          label: `${interventionLabel} - Refund`,
          debit: money(item.refundAmount),
          credit: 0,
          interventionId: item.interventionId,
        },
      ];
    });

    const totalDebit = sumMoneyOf(rows.map((row) => row.debit));

    const totalCredit = sumMoneyOf(rows.map((row) => row.credit));

    const csv = this.buildCsv(
      [
        'date',
        'account',
        'label',
        'debit',
        'credit',
        'interventionId',
      ],
      rows.map((row) => [
        row.date,
        row.account,
        row.label,
        toMoneyString(row.debit),
        toMoneyString(row.credit),
        row.interventionId,
      ]),
    );

    const fileName = `accounting-export-${Date.now()}.csv`;

    const exportRecord = await this.prisma.accountingExport.create({
      data: {
        periodStart: new Date(query.from),
        periodEnd: new Date(query.to),
        format: query.format || BusinessExportFormat.CSV,
        status: AccountingExportStatus.GENERATED,
        fileName,
        totalLines: rows.length,
        totalDebit,
        totalCredit,
        data: this.toJsonValue(rows),
        generatedById: userId,
      },
      include: {
        generatedBy: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
      },
    });

    return {
      export: exportRecord,
      file: {
        filename: fileName,
        contentType: 'text/csv; charset=utf-8',
        buffer: Buffer.from(csv, 'utf8'),
      },
    };
  }
}
