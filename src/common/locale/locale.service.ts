/**
 * Reads the locale of the company (currency, time zone, VAT rates) from `CompanySettings` into `common/locale/locale`
 * when the server starts, and again every few minutes: the administrators change the settings on one instance, the
 * others follow without a restart. The administrators' own save applies them at once (AdminService).
 *
 * A row that cannot be read (a rate list that does not hold the default rate, a time zone this runtime does not know) never
 * stops the server: the locale stays what it was, and the problem is in the log.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { PrismaService } from '../../prisma/prisma.service';
import { describeError } from '../../modules/notifications/delivery/delivery-error';
import { DEFAULT_TAX_RATES, LocaleInput, applyLocale, isValidRate } from './locale';

/**
 * The list of rates a settings row stands for. A row from before the list existed (it was saved with a single rate, often the
 * old 20 %) has none: it gets the rates of the country, plus the rate the row already had when that one is not among them, so
 * that the row is still valid and every save of its other fields still goes through.
 */
export function effectiveTaxRates(row: { taxRates?: unknown; defaultTaxRate?: unknown }): unknown {
  if (row.taxRates !== null && row.taxRates !== undefined) return row.taxRates;

  const rates: Array<{ code: string; label: string; rate: number }> = DEFAULT_TAX_RATES.map((rate) => ({ ...rate }));
  const own = row.defaultTaxRate === null || row.defaultTaxRate === undefined || row.defaultTaxRate === '' ? NaN : Number(String(row.defaultTaxRate));

  if (isValidRate(own) && !rates.some((rate) => rate.rate === own)) rates.push({ code: 'CURRENT', label: `TVA ${own} %`, rate: own });

  return rates;
}

/** The columns of the settings row that make the locale. */
export function localeOfRow(row: { currency?: string | null; timezone?: string | null; taxRates?: unknown; defaultTaxRate?: unknown }): LocaleInput {
  return {
    currency: row.currency,
    timezone: row.timezone,
    taxRates: effectiveTaxRates(row),
    defaultTaxRate: row.defaultTaxRate,
  };
}

@Injectable()
export class LocaleService implements OnModuleInit {
  private readonly logger = new Logger(LocaleService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.refresh();
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async refresh(): Promise<boolean> {
    try {
      const row = await this.prisma.companySettings.findFirst({ orderBy: { id: 'asc' } });

      if (!row) return false;

      applyLocale(localeOfRow(row));

      return true;
    } catch (error) {
      this.logger.error(`The locale of the company settings was not applied (${describeError(error)}).`);

      return false;
    }
  }
}
