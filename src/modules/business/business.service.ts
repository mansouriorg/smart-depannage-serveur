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

import {
  BusinessDateRangeQueryDto,
  CalculateInterventionFinancialsDto,
  CreateMonthlyReportDto,
  CreatePayoutDto,
  ExportQueryDto,
  MarkPayoutPaidDto,
} from './dto/business.dto';

@Injectable()
export class BusinessService {
  constructor(private readonly prisma: PrismaService) {}

  // ==========================================================
  // Helpers
  // ==========================================================

  private isStaff(role: Role): boolean {
    return [
      Role.ADMIN,
      Role.SUPER_ADMIN,
      Role.SUPPORT,
      Role.DISPATCHER,
      Role.ACCOUNTANT,
    ].includes(role);
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
      : new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));

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

  private monthRange(year: number, month: number) {
    const from = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
    const to = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

    return {
      from,
      to,
    };
  }

  private roundMoney(value: number) {
    return Number((value || 0).toFixed(2));
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

    const totalPrice = this.roundMoney(dto.totalPrice);
    const commissionRate = dto.commissionRate ?? 20;
    const paymentProviderFee = this.roundMoney(dto.paymentProviderFee ?? 0);
    const refundAmount = this.roundMoney(dto.refundAmount ?? 0);
    const currency = dto.currency || 'EUR';

    let platformCommission = this.roundMoney(
      totalPrice * (commissionRate / 100),
    );

    let artisanPayout =
      dto.artisanPayout !== undefined
        ? this.roundMoney(dto.artisanPayout)
        : this.roundMoney(totalPrice - platformCommission);

    if (dto.artisanPayout !== undefined) {
      platformCommission = this.roundMoney(totalPrice - artisanPayout);
    }

    if (artisanPayout < 0 || platformCommission < 0) {
      throw new BadRequestException(
        'Montants invalides: vérifiez totalPrice, artisanPayout et commissionRate.',
      );
    }

    const netRevenue = this.roundMoney(
      platformCommission - paymentProviderFee - refundAmount,
    );

    const companyMargin = netRevenue;

    const financials = await this.prisma.interventionFinancials.upsert({
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

    return financials;
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
      (item) => item.refundAmount > 0,
    ).length;

    const totalRevenue = this.roundMoney(
      financials.reduce((sum, item) => sum + item.totalPrice, 0),
    );

    const totalCommission = this.roundMoney(
      financials.reduce((sum, item) => sum + item.platformCommission, 0),
    );

    const totalArtisanPayouts = this.roundMoney(
      financials.reduce((sum, item) => sum + item.artisanPayout, 0),
    );

    const totalPaymentFees = this.roundMoney(
      financials.reduce((sum, item) => sum + item.paymentProviderFee, 0),
    );

    const totalRefunds = this.roundMoney(
      financials.reduce((sum, item) => sum + item.refundAmount, 0),
    );

    const netRevenue = this.roundMoney(
      financials.reduce((sum, item) => sum + item.netRevenue, 0),
    );

    const companyMargin = this.roundMoney(
      financials.reduce((sum, item) => sum + item.companyMargin, 0),
    );

    const averageOrderValue =
      interventionCount === 0
        ? 0
        : this.roundMoney(totalRevenue / interventionCount);

    const marginRate =
      totalRevenue === 0
        ? 0
        : this.roundMoney((companyMargin / totalRevenue) * 100);

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
        currency: 'EUR',

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

        data: dashboard as unknown as Prisma.InputJsonValue,

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

    const grossAmount = this.roundMoney(
      financials.reduce((sum, item) => sum + item.artisanPayout, 0),
    );

    const refundsDeducted = 0;
    const paymentProviderFees = 0;
    const netAmount = this.roundMoney(
      grossAmount - refundsDeducted - paymentProviderFees,
    );

    return this.prisma.artisanPayout.create({
      data: {
        artisanId: dto.artisanId,
        status: PayoutStatus.READY,
        periodStart,
        periodEnd,
        currency: 'EUR',
        grossAmount,
        paymentProviderFees,
        refundsDeducted,
        netAmount,
        notes: dto.notes?.trim() || null,
        items: {
          create: financials.map((item) => ({
            financialId: item.id,
            interventionId: item.interventionId,
            amount: item.artisanPayout,
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
        item.totalPrice,
        item.artisanPayout,
        item.platformCommission,
        item.paymentProviderFee,
        item.refundAmount,
        item.netRevenue,
        item.companyMargin,
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
      `Total revenue: ${dashboard.totals.totalRevenue} EUR`,
      `Total commission: ${dashboard.totals.totalCommission} EUR`,
      `Artisan payouts: ${dashboard.totals.totalArtisanPayouts} EUR`,
      `Payment fees: ${dashboard.totals.totalPaymentFees} EUR`,
      `Refunds: ${dashboard.totals.totalRefunds} EUR`,
      `Net revenue: ${dashboard.totals.netRevenue} EUR`,
      `Company margin: ${dashboard.totals.companyMargin} EUR`,
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
      const date = item.createdAt.toISOString().slice(0, 10);
      const interventionLabel = `Intervention #${item.interventionId}`;

      return [
        {
          date,
          account: 'CLIENT_REVENUE',
          label: `${interventionLabel} - Client payment`,
          debit: item.totalPrice,
          credit: 0,
          interventionId: item.interventionId,
        },
        {
          date,
          account: 'ARTISAN_PAYABLE',
          label: `${interventionLabel} - Artisan payout`,
          debit: 0,
          credit: item.artisanPayout,
          interventionId: item.interventionId,
        },
        {
          date,
          account: 'PLATFORM_COMMISSION',
          label: `${interventionLabel} - Platform commission`,
          debit: 0,
          credit: item.platformCommission,
          interventionId: item.interventionId,
        },
        {
          date,
          account: 'PAYMENT_FEES',
          label: `${interventionLabel} - Payment provider fee`,
          debit: item.paymentProviderFee,
          credit: 0,
          interventionId: item.interventionId,
        },
        {
          date,
          account: 'REFUNDS',
          label: `${interventionLabel} - Refund`,
          debit: item.refundAmount,
          credit: 0,
          interventionId: item.interventionId,
        },
      ];
    });

    const totalDebit = this.roundMoney(
      rows.reduce((sum, row) => sum + row.debit, 0),
    );

    const totalCredit = this.roundMoney(
      rows.reduce((sum, row) => sum + row.credit, 0),
    );

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
        row.debit,
        row.credit,
        row.interventionId,
      ]),
    );

    const exportRecord = await this.prisma.accountingExport.create({
      data: {
        periodStart: new Date(query.from),
        periodEnd: new Date(query.to),
        format: query.format || BusinessExportFormat.CSV,
        status: AccountingExportStatus.GENERATED,
        fileName: `accounting-export-${Date.now()}.csv`,
        totalLines: rows.length,
        totalDebit,
        totalCredit,
        data: rows as unknown as Prisma.InputJsonValue,
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
        filename: exportRecord.fileName,
        contentType: 'text/csv; charset=utf-8',
        buffer: Buffer.from(csv, 'utf8'),
      },
    };
  }
}