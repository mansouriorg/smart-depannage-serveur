import {
  BadRequestException,
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
  Status,
} from '../../../generated/prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { compareMoney, divideMoney, formatMoney, money, percentOf, ratioPercent, subtractMoney, sumMoneyOf, toMoneyString } from '../../common/money/money';
import { decimalsToNumbers } from '../../common/money/money-numbers';
import { currencyCode } from '../../common/locale/locale';
import { businessDateOf, businessMonthRange, startOfBusinessMonth } from '../../common/locale/business-time';

import {
  BusinessDateRangeQueryDto,
  CalculateInterventionFinancialsDto,
  CreateMonthlyReportDto,
  CreatePayoutDto,
  ExportQueryDto,
  MarkPayoutPaidDto,
} from './dto/business.dto';

/** The share of the price that the platform keeps when nobody gave a rate (percent). */
const DEFAULT_COMMISSION_RATE = 20;

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

  private paidStatuses(): Status[] {
    return [
      Status.COMPLETED,
      Status.PAYMENT_PENDING,
      Status.PAID,
      Status.INVOICE_SENT,
      Status.INVOICE_READY,
    ];
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
        invoice: true,
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

    const totalPrice = money(dto.totalPrice);
    const commissionRate = dto.commissionRate ?? DEFAULT_COMMISSION_RATE;
    const paymentProviderFee = money(dto.paymentProviderFee ?? 0);
    const refundAmount = money(dto.refundAmount ?? 0);
    const currency = dto.currency || currencyCode();

    let platformCommission = percentOf(totalPrice, commissionRate);

    const artisanPayout =
      dto.artisanPayout !== undefined
        ? money(dto.artisanPayout)
        : subtractMoney(totalPrice, platformCommission);

    if (dto.artisanPayout !== undefined) {
      platformCommission = subtractMoney(totalPrice, artisanPayout);
    }

    if (artisanPayout < 0 || platformCommission < 0) {
      throw new BadRequestException(
        'Montants invalides: vérifiez totalPrice, artisanPayout et commissionRate.',
      );
    }

    const netRevenue = subtractMoney(subtractMoney(platformCommission, paymentProviderFee), refundAmount);

    const companyMargin = netRevenue;

    return this.prisma.interventionFinancials.upsert({
      where: {
        interventionId,
      },
      update: {
        totalPrice,
        commissionRate,
        platformCommission,
        artisanPayout,
        paymentProviderFee,
        refundAmount,
        netRevenue,
        companyMargin,
        currency,
        notes: dto.notes?.trim() || null,
        calculatedById: userId,
      },
      create: {
        interventionId,
        totalPrice,
        commissionRate,
        platformCommission,
        artisanPayout,
        paymentProviderFee,
        refundAmount,
        netRevenue,
        companyMargin,
        currency,
        notes: dto.notes?.trim() || null,
        calculatedById: userId,
      },
      include: this.financialInclude(),
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

    const paidInterventionCount = financials.filter((item) =>
      this.paidStatuses().includes(item.intervention.status),
    ).length;

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

  async createArtisanPayout(
    userId: number,
    role: Role,
    dto: CreatePayoutDto,
  ) {
    this.assertStaff(role);

    const periodStart = new Date(dto.periodStart);
    const periodEnd = new Date(dto.periodEnd);

    if (
      Number.isNaN(periodStart.getTime()) ||
      Number.isNaN(periodEnd.getTime()) ||
      periodStart > periodEnd
    ) {
      throw new BadRequestException('Période invalide.');
    }

    const artisan = await this.prisma.user.findFirst({
      where: {
        id: dto.artisanId,
        role: Role.ARTISAN,
        isActive: true,
        deletedAt: null,
      },
    });

    if (!artisan) {
      throw new NotFoundException('Artisan introuvable.');
    }

    const financials = await this.prisma.interventionFinancials.findMany({
      where: {
        createdAt: {
          gte: periodStart,
          lte: periodEnd,
        },
        intervention: {
          artisanId: dto.artisanId,
        },
        payoutItems: {
          none: {},
        },
      },
      include: this.financialInclude(),
      orderBy: {
        createdAt: 'asc',
      },
    });

    if (!financials.length) {
      throw new BadRequestException(
        'Aucune intervention financière disponible pour ce payout.',
      );
    }

    const grossAmount = sumMoneyOf(financials.map((item) => item.artisanPayout));

    const refundsDeducted = 0;
    const paymentProviderFees = 0;
    const netAmount = subtractMoney(subtractMoney(grossAmount, refundsDeducted), paymentProviderFees);

    return this.prisma.artisanPayout.create({
      data: {
        artisanId: dto.artisanId,
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
          create: financials.map((item) => ({
            financialId: item.id,
            interventionId: item.interventionId,
            amount: money(item.artisanPayout),
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

  async markPayoutPaid(
    userId: number,
    role: Role,
    payoutId: number,
    dto: MarkPayoutPaidDto,
  ) {
    this.assertStaff(role);

    const payout = await this.prisma.artisanPayout.findUnique({
      where: {
        id: payoutId,
      },
    });

    if (!payout) {
      throw new NotFoundException('Payout introuvable.');
    }

    return this.prisma.artisanPayout.update({
      where: {
        id: payoutId,
      },
      data: {
        status: PayoutStatus.PAID,
        paidAt: dto.paidAt ? new Date(dto.paidAt) : new Date(),
        paymentReference: dto.paymentReference?.trim() || null,
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
        items: true,
      },
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
