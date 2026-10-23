import * as fs from 'fs';
import * as path from 'path';

import { listSourceFiles, readSource, stripComments } from '../testing/source-scan';
import { alterStatement, currencyColumns, needsConversion, planDecimalColumns, roundingQuery } from './migrate-money-plan';

const SCHEMA = fs.readFileSync(path.resolve(__dirname, '../../../prisma/schema.prisma'), 'utf8');

/** Columns of the schema as `Model.column -> type line`. */
function columns(): Array<{ model: string; column: string; line: string }> {
  const out: Array<{ model: string; column: string; line: string }> = [];

  for (const [, model, body] of SCHEMA.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    for (const line of body.split('\n')) {
      const field = /^\s*(\w+)\s+(\w+)/.exec(line);

      if (field) out.push({ model, column: field[1], line: line.trim() });
    }
  }

  return out;
}

const MONEY_NAME = /(amount|price|total|fee|commission|payout|revenue|margin|debit|credit|refund|balance|cost|tax|Rate$)/i;

describe('the money of the schema is DECIMAL, in dinars (P2-01)', () => {
  it('no column that looks like money is a Float', () => {
    const floats = columns().filter((entry) => /\bFloat\b/.test(entry.line));
    const wrong = floats.filter((entry) => MONEY_NAME.test(entry.column)).map((entry) => `${entry.model}.${entry.column}`);

    expect(wrong).toEqual([]);
    // What stays a Float is not money: positions, distances, a rating, a quantity.
    expect(floats.map((entry) => entry.column).sort().filter((name, at, all) => all.indexOf(name) === at)).toEqual([
      'accuracyM',
      'afterPhotoLat',
      'afterPhotoLng',
      'averageRating',
      'beforePhotoLat',
      'beforePhotoLng',
      'detail',
      'latitude',
      'longitude',
      'quantity',
      'radiusKm',
    ]);
  });

  it('amounts are DECIMAL(14,3) (millimes) and percents DECIMAL(5,2)', () => {
    const decimals = planDecimalColumns(SCHEMA);

    expect(decimals.length).toBeGreaterThan(30);

    for (const entry of decimals) {
      const percent = /Rate$/.test(entry.column);

      expect(`${entry.model}.${entry.column}: ${entry.precision},${entry.scale}`).toBe(`${entry.model}.${entry.column}: ${percent ? '5,2' : '14,3'}`);
    }

    for (const wanted of ['Quote.amountHT', 'Quote.taxRate', 'QuoteItem.unitPrice', 'Payment.amount', 'Payment.amountRefunded', 'Invoice.amountTTC', 'InterventionFinancials.netRevenue', 'ArtisanPayout.netAmount', 'BusinessReport.totalRevenue', 'AccountingExport.totalDebit', 'CompanySettings.defaultTaxRate', 'SubService.basePrice', 'Complaint.refundAmount']) {
      expect(decimals.map((entry) => `${entry.model}.${entry.column}`)).toContain(wanted);
    }
  });

  it('the defaults are Tunisian: TND, the clock of Tunis and 19 %', () => {
    expect(SCHEMA).not.toContain('"EUR"');
    expect(SCHEMA).not.toContain('Europe/Paris');

    for (const entry of columns().filter((item) => item.column === 'currency')) {
      expect(`${entry.model}: ${entry.line}`).toContain('@default("TND")');
    }

    for (const model of ['Quote', 'Invoice']) {
      expect(columns().some((entry) => entry.model === model && entry.column === 'currency')).toBe(true);
    }

    expect(columns().find((entry) => entry.model === 'Appointment' && entry.column === 'timezone')?.line).toContain('@default("Africa/Tunis")');
    expect(columns().find((entry) => entry.model === 'Quote' && entry.column === 'taxRate')?.line).toContain('@default(19)');
    expect(columns().find((entry) => entry.model === 'Invoice' && entry.column === 'taxRate')?.line).toContain('@default(19)');
    expect(columns().find((entry) => entry.model === 'CompanySettings' && entry.column === 'defaultTaxRate')?.line).toContain('@default(19)');
  });

  it('the company settings hold the locale and what an invoice prints', () => {
    const settings = columns().filter((entry) => entry.model === 'CompanySettings').map((entry) => entry.column);

    for (const wanted of ['currency', 'timezone', 'taxRates', 'defaultTaxRate', 'rib', 'matriculeFiscal']) expect(settings).toContain(wanted);
  });
});

describe('the migration moves the columns without losing a millime (P2-01)', () => {
  it('plans every DECIMAL column of the schema, with a rounding that PostgreSQL does too', () => {
    const plan = planDecimalColumns(SCHEMA);
    const sql = alterStatement(plan.find((entry) => entry.model === 'Quote' && entry.column === 'amountHT')!);

    expect(sql).toBe('ALTER TABLE "Quote" ALTER COLUMN "amountHT" TYPE NUMERIC(14,3) USING ROUND("amountHT"::numeric, 3)');
    expect(alterStatement(plan.find((entry) => entry.model === 'Quote' && entry.column === 'taxRate')!)).toContain('NUMERIC(5,2) USING ROUND("taxRate"::numeric, 2)');
    expect(roundingQuery(plan[0])).toContain('MAX(ABS(');
    expect(roundingQuery(plan[0])).toContain(`ROUND("${plan[0].column}"::numeric, ${plan[0].scale})`);
    expect(roundingQuery(plan[0])).not.toContain('0.0005');
  });

  it('reads a renamed table and refuses a Decimal without a precision or an unsafe name', () => {
    const renamed = 'model Quote {\n  id Int @id\n  amountHT Decimal @db.Decimal(14, 3)\n  @@map("quotes")\n}\n';

    expect(planDecimalColumns(renamed)).toEqual([{ model: 'Quote', table: 'quotes', column: 'amountHT', precision: 14, scale: 3, optional: false }]);
    expect(() => planDecimalColumns('model Quote {\n  id Int @id\n  amountHT Decimal\n}\n')).toThrow('without @db.Decimal');
    expect(() => planDecimalColumns('model Quote {\n  id Int @id\n  amountHT Decimal @db.Decimal(14, 3)\n  @@map("q; DROP")\n}\n')).toThrow('unsafe name');
  });

  it('converts a floating-point column, leaves a DECIMAL one, and ignores a column that does not exist yet', () => {
    const column = { model: 'Quote', table: 'Quote', column: 'amountHT', precision: 14, scale: 3, optional: false };

    expect(needsConversion({ data_type: 'double precision', numeric_precision: 53, numeric_scale: null }, column)).toBe(true);
    expect(needsConversion({ data_type: 'real', numeric_precision: 24, numeric_scale: null }, column)).toBe(true);
    expect(needsConversion({ data_type: 'numeric', numeric_precision: 14, numeric_scale: 3 }, column)).toBe(false);
    expect(needsConversion({ data_type: 'numeric', numeric_precision: 12, numeric_scale: 2 }, column)).toBe(true);
    expect(needsConversion(undefined, column)).toBe(false);
  });

  it('knows the tables that carry a currency', () => {
    const tables = currencyColumns(SCHEMA).map((entry) => entry.table);

    for (const wanted of ['Quote', 'Invoice', 'Payment', 'InterventionFinancials', 'ArtisanPayout', 'BusinessReport', 'CompanySettings']) expect(tables).toContain(wanted);
  });

  it('the script is there, runs nothing without --apply, and is on the npm scripts', () => {
    const script = fs.readFileSync(path.resolve(__dirname, '../../../scripts/migrate-money.ts'), 'utf8');
    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8'));

    expect(manifest.scripts['money:migrate']).toBe('ts-node scripts/migrate-money.ts');
    expect(script).toContain("process.argv.includes('--apply')");
    expect(script).toContain("process.argv.includes('--tunisia')");
    expect(script).toContain("await client.query('BEGIN')");
    expect(script).toContain("await client.query('ROLLBACK')");
    // Nothing is written before the check of `apply`.
    expect(script.indexOf('if (!apply)')).toBeLessThan(script.indexOf("client.query('BEGIN')"));
  });
});

/** The money columns by name, for the scans of the code below. */
const MONEY_FIELDS = ['commissionRate', 'totalRefunds', 'totalArtisanPayouts', 'totalPaymentFees', 'amountHT', 'amountTTC', 'taxAmount', 'taxRate', 'unitPrice', 'amountRefunded', 'totalPrice', 'platformCommission', 'artisanPayout', 'paymentProviderFee', 'refundAmount', 'netRevenue', 'companyMargin', 'grossAmount', 'paymentProviderFees', 'refundsDeducted', 'netAmount', 'basePrice', 'emergencyPrice', 'defaultEmergencyFee', 'defaultTaxRate', 'totalRevenue', 'totalCommission', 'totalDebit', 'totalCredit', 'cashAmount', 'commissionAmount'];

/** Any read of an amount from a row (`payment.amount`, `quote?.amountHT`), found in a piece of code. */
const ACCESS = new RegExp(`\\b[a-zA-Z_]\\w*\\??\\.(?:${MONEY_FIELDS.join('|')}|amount)\\b`, 'g');
/** An operator that is not an assignment, an arrow or a type: + - * / % < > <= >= == != === !== and the compound assignments. */
const ON_THE_LEFT = /(?:[+\-*/%]=|\+|(?<![=-])-|\*|\/|%|<=|>=|(?<![=<>-])<|(?<![=-])>|===|!==|==|!=)$/;
const ON_THE_RIGHT = /^(?:[+\-*/%]=|\+|-(?!>)|\*|\/|%|<=|>=|<|>|===|!==|==|!=)/;
/** `x.amount === null` or `=== ''` asks whether there is an amount, which is not arithmetic. */
const NOTHING_CHECK = /^(?:===|!==|==|!=)\s*(?:null\b|undefined\b|'')/;

/** The reads of an amount that have an operator next to them: the places where a Decimal would be treated as a number. */
function arithmeticOn(code: string): string[] {
  const found: string[] = [];

  for (const match of code.matchAll(ACCESS)) {
    const before = code.slice(0, match.index).trimEnd();
    const after = code.slice((match.index ?? 0) + match[0].length).trimStart();

    if (NOTHING_CHECK.test(after)) continue;
    if (ON_THE_LEFT.test(before) || ON_THE_RIGHT.test(after)) found.push(`${before.slice(-12).trim()} ${match[0]} ${after.slice(0, 8).trim()}`);
  }

  return found;
}

/** Files that are allowed to look at money the way a number is looked at: the helpers that define it. */
const MONEY_HELPERS = new Set(['common/money/money.ts', 'common/money/money-numbers.ts', 'common/money/document-totals.ts', 'common/money/migrate-money-plan.ts', 'common/locale/locale.ts']);

/** Builds the payloads of the live events: they leave through the gateway, which turns every Decimal into a number (checked below). */
const LIVE_EVENTS = 'modules/realtime/realtime.service.ts';

describe('the code keeps to the locale (P2-01)', () => {
  const files = listSourceFiles();

  it('finds the source files', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('modules/quotes/quotes.service.ts');
  });

  it('no euro sign and no "EUR" in the code: the currency is the one of the company', () => {
    const found: string[] = [];

    for (const file of files) {
      const code = stripComments(readSource(file));

      if (code.includes('€')) found.push(`${file}: €`);
      if (/['"`]EUR['"`]/.test(code)) found.push(`${file}: 'EUR'`);
      if (/\bEUR\b/.test(code.replace(/['"`][^'"`\n]*['"`]/g, '""')) ) found.push(`${file}: EUR`);
    }

    expect(found).toEqual([]);
  });

  it('no date maths on the clock of the server: days, months and hours go through common/locale/business-time', () => {
    const found: string[] = [];
    const LOCAL = /\.(setHours|getHours|getMinutes|setMinutes|getDay|getDate|setDate|getMonth|setMonth|getFullYear|setFullYear|toLocaleTimeString|toLocaleDateString|toLocaleString|getTimezoneOffset)\(/;

    for (const file of files) {
      const code = stripComments(readSource(file));

      if (LOCAL.test(code)) found.push(`${file}: ${LOCAL.exec(code)?.[1]}`);
      if (/new Date\([a-zA-Z.]*\.get(Full)?Year\(\)/.test(code)) found.push(`${file}: a date built from the local year`);
    }

    expect(found).toEqual([]);
  });

  it('no private rounding of money: nothing but common/money rounds an amount', () => {
    const found: string[] = [];

    for (const file of files) {
      if (MONEY_HELPERS.has(file)) continue;

      const code = stripComments(readSource(file));

      if (/\broundMoney\b/.test(code)) found.push(`${file}: roundMoney`);
      for (const field of MONEY_FIELDS) {
        if (new RegExp(`\\b${field}\\b[^\\n;]*Math\\.round|Math\\.round[^\\n;]*\\b${field}\\b|\\b${field}\\b[^\\n;]*toFixed\\(`).test(code)) found.push(`${file}: ${field} rounded by hand`);
      }
    }

    expect(found).toEqual([]);
  });

  it('a money column is never added, compared or multiplied as if it were a number', () => {
    const found: string[] = [];
    const names = MONEY_FIELDS.join('|');
    const asNumber = new RegExp(`\\b(?:Number|parseFloat|parseInt|Math\\.\\w+)\\(\\s*[a-zA-Z_]\\w*\\??\\.(?:${names}|amount)\\b`);
    const spread = /\bsumMoney\(\s*\.\.\./;

    for (const file of files) {
      if (MONEY_HELPERS.has(file)) continue;

      // The request objects (DTOs) hold numbers that a person typed: they are numbers before they are Decimals.
      const code = stripComments(readSource(file)).replace(/\bdto\.\w+/g, 'dto_');

      for (const hit of arithmeticOn(code)) found.push(`${file}: ${hit}`);

      const number = asNumber.exec(code);

      if (number) found.push(`${file}: ${number[0]} (a Decimal read as a number)`);
      // A list of any length is not spread into arguments (a few hundred thousand rows overflow the call).
      if (spread.test(code)) found.push(`${file}: sumMoney(...list)`);
    }

    expect(found).toEqual([]);
  });

  it('the scan above sees the shapes it is meant to see', () => {
    for (const bad of ['a = x.amount + 1', 'sum += payment.amount', 'items.reduce((a, p) => a + p.amount, 0)', 'if (0 < payment.amount)', 'x.amountTTC * 2', 'total -= quote?.amountHT', '-x.amount']) {
      expect(`${bad}: ${arithmeticOn(bad).length}`).toBe(`${bad}: 1`);
    }

    expect(arithmeticOn('a.amount === b.amount').length).toBe(2);

    for (const fine of ['const a = x.amount', 'money(x.amount)', 'f(a, x.amount)', 'rows.map((p) => p.amount)', 'cond ? x.amount : 0', '{ amount: payment.amount }', 'const t = (p) => p.amount;', 'if (row.defaultTaxRate === null || row.defaultTaxRate === undefined)']) {
      expect(`${fine}: ${arithmeticOn(fine).length}`).toBe(`${fine}: 0`);
    }
  });

  it('an amount in a message goes through formatMoney, never straight into the text', () => {
    const found: string[] = [];
    const names = MONEY_FIELDS.join('|');
    const inText = new RegExp('\\$\\{(?![^}]*(formatMoney|toMoneyString|money\\())[^}]*\\.(?:' + names + '|amount)\\b[^}]*\\}');

    for (const file of files) {
      if (MONEY_HELPERS.has(file)) continue;

      const code = stripComments(readSource(file));
      const hit = inText.exec(code);

      if (hit) found.push(`${file}: ${hit[0]}`);
    }

    expect(found).toEqual([]);
  });

  it('every amount written to a JSON column is a number: events and notifications read it with money()', () => {
    const found: string[] = [];

    for (const file of files) {
      if (MONEY_HELPERS.has(file) || file === LIVE_EVENTS) continue;

      const code = stripComments(readSource(file));

      for (const match of code.matchAll(/\b(amountHT|amountTTC|taxAmount|amountRefunded|refundAmount|amount)\s*:\s*(quote|payment|invoice|financials)\.\w+\s*[,}\n]/g)) {
        found.push(`${file}: ${match[0].trim()}`);
      }
    }

    // `amount: payment.amount` inside a `data` / `metadata` object would put a Decimal in a JSON column.
    expect(found).toEqual([]);
  });

  it('every amount and every rate that a person can send is checked by @IsMoney / @IsTaxRate, never by a bare @IsNumber', () => {
    const found: string[] = [];
    const checked: string[] = [];
    const MONEY_PROPERTY = /(amount|price|fee|cost|tax|total|refund|payout|commission|Rate$)/i;

    for (const file of files.filter((name) => name.endsWith('.dto.ts'))) {
      const lines = stripComments(readSource(file)).split('\n');

      lines.forEach((line, at) => {
        const property = /^\s+(\w+)[?!]?:\s*number\b/.exec(line);

        if (!property || !MONEY_PROPERTY.test(property[1])) return;

        const above: string[] = [];

        for (let up = at - 1; up >= 0 && lines[up].trim() && !/[;{}]\s*$/.test(lines[up]); up -= 1) above.unshift(lines[up].trim());

        const decorators = above.join(' ');

        checked.push(`${file}: ${property[1]}`);

        if (!/@(IsMoney|IsTaxRate)\(/.test(decorators) || /@IsNumber\(/.test(decorators)) found.push(`${file}: ${property[1]} has ${decorators || 'no validator'}`);
      });
    }

    expect(checked.length).toBeGreaterThan(15);
    expect(found).toEqual([]);
  });

  it('@IsMoney and @IsTaxRate use the rules of money-rules, not the decimal counter of class-validator (which throws on 1e-7)', () => {
    const decorators = readSource('common/money/money-validation.ts');
    const rules = readSource('common/money/money-rules.ts');

    expect(decorators).toContain('isValidAmount(value, min)');
    expect(decorators).toContain('isValidTaxRate(value)');
    expect(decorators).not.toContain('maxDecimalPlaces');
    expect(decorators).not.toMatch(/\bIsNumber\b/);
    expect(rules).toContain('value > MAX_COLUMN_AMOUNT');
    expect(rules).toContain('money(value) === value');
  });

  it('the global interceptor and the websocket gateway turn Decimals into numbers', () => {
    expect(readSource('app.module.ts')).toContain('MoneyNumbersInterceptor');
    expect(readSource('modules/realtime/realtime.gateway.ts').match(/decimalsToNumbers\(payload\)/g)?.length).toBe(5);
    expect(readSource('modules/business/business.service.ts')).toContain('decimalsToNumbers(value)');
  });

  it('the locale is read when the server starts and again every few minutes', () => {
    const service = readSource('common/locale/locale.service.ts');

    expect(service).toContain('onModuleInit');
    expect(service).toContain('@Cron(CronExpression.EVERY_5_MINUTES)');
    expect(readSource('modules/admin/admin.module.ts')).toContain('LocaleService');
  });
});
