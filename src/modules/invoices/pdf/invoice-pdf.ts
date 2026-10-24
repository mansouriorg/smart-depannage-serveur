/**
 * The invoice and the credit note as PDF files (P2-07), drawn from the document as it was issued.
 *
 * Nothing here reads the settings of the company: the company, the customer, the legal mentions, the stamp duty and the bank account
 * are the ones the document kept the day it was issued, so the file of an old invoice reads the same today. The PDF is not stored:
 * it is drawn each time it is asked for, and the same document gives the same bytes.
 *
 * The page: the company and the title with the number and the date; the customer and the job; the lines; the totals (VAT, stamp duty,
 * credit notes, net to pay); the amount in words; how to pay or that it was paid; the legal mentions at the foot of every page.
 */
import { businessDateOf } from '../../../common/locale/business-time';
import { formatMoney, money, subtractMoney, sumMoney, sumMoneyOf } from '../../../common/money/money';
import { serviceLabel } from '../service-labels';
import { amountInWords } from './amount-in-words';
import { A4, PdfDocument, PdfFont, PdfPage, textWidth, wrapText } from './pdf-writer';

type Row = Record<string, any>;

export interface RenderedPdf {
  buffer: Buffer;
  /** Something of the document is not in the file as it is in the data: a character that could not be drawn (Arabic script, for one) is a "?", or a very long text was cut. The file says so at its foot. */
  lossy: boolean;
}

const MARGIN = 40;
const RIGHT = A4.width - MARGIN;
const WIDTH = RIGHT - MARGIN;

const INK = '#0f172a';
const MUTED = '#475569';
const FAINT = '#64748b';
const RULE = '#cbd5e1';
const FILL = '#f1f5f9';
const ACCENT = '#0b4f6c';
const GOOD = '#166534';
const BAD = '#b91c1c';

/** Table columns: description, quantity, unit price, total. */
const COLUMN_LABEL = { left: MARGIN, width: 265 };
const COLUMN_QUANTITY_RIGHT = MARGIN + 265 + 50 - 6;
const COLUMN_UNIT_RIGHT = MARGIN + 265 + 50 + 100 - 6;
const COLUMN_TOTAL_RIGHT = RIGHT - 6;

const MAX_LABEL_LINES = 8;
const MAX_DESCRIPTION_LINES = 30;
/**
 * The legal mentions are on the foot of every page, so more lines than this would take the page. The setting allows 2000 characters:
 * as one paragraph of ordinary text that is about 14 lines, which are all printed; a text with many line breaks is cut.
 */
const MAX_LEGAL_LINES = 20;
/** More credit notes than this on one invoice: the first ones are added up in one row of the totals. */
const MAX_CREDIT_ROWS = 12;

/** What the file says when part of the document could not be put in it. */
const LOSSY_NOTICE = 'Certains caractères ou passages de ce document n’ont pas pu être reproduits dans ce PDF (écriture non latine, texte trop long).';

const text = (value: unknown): string => (value === null || value === undefined ? '' : String(value).trim());

/** "2026-10-24" as "24/10/2026". */
export function frenchDate(at: unknown): string {
  if (!at) return '';

  const moment = at instanceof Date ? at : new Date(String(at));

  if (Number.isNaN(moment.getTime())) return '';

  const [year, month, day] = businessDateOf(moment).split('-');

  return `${day}/${month}/${year}`;
}

/** A rate or a quantity the way it is written in French: "19", "5,5", "12,34". */
function plain(value: unknown): string {
  if (value === null || value === undefined || String(value).trim() === '') return '';

  const number = Number(String(value));

  if (!Number.isFinite(number)) return text(value);

  return String(Math.round(number * 1000) / 1000).replace('.', ',');
}

/** "TVA 19 %". */
const vatLabel = (rate: unknown): string => (plain(rate) === '' ? 'TVA' : `TVA ${plain(rate)} %`);

const capitalize = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

/** Lines cut to a number of lines at most; the last one ends in "…" when text was left out (and `onCut` is told). */
function limited(lines: string[], max: number, fit: { width: number; font: PdfFont; size: number }, onCut: () => void): string[] {
  if (lines.length <= max) return lines;

  onCut();

  let last = lines[max - 1].trimEnd();

  while (last !== '' && textWidth(`${last}…`, fit.font, fit.size) > fit.width) last = last.slice(0, -1).trimEnd();

  return [...lines.slice(0, max - 1), `${last}…`];
}

interface Line {
  text: string;
  bold?: boolean;
  size?: number;
  color?: string;
}

/** Wraps lines of a block to its width: one entry for each line drawn. */
function laidOut(lines: Line[], width: number): Line[] {
  const out: Line[] = [];

  for (const line of lines) {
    for (const part of wrapText(line.text, width, line.bold ? 'bold' : 'regular', line.size ?? 9.5)) out.push({ ...line, text: part });
  }

  return out;
}

const lineHeight = (line: Line): number => (line.size ?? 9.5) * 1.3;

const heightOf = (lines: Line[]): number => lines.reduce((total, line) => total + lineHeight(line), 0);

function drawLines(page: PdfPage, lines: Line[], x: number, top: number, options: { align?: 'left' | 'right' } = {}): number {
  let y = top;

  for (const line of lines) {
    y += lineHeight(line);
    page.text(line.text, x, y - (line.size ?? 9.5) * 0.28, { font: line.bold ? 'bold' : 'regular', size: line.size ?? 9.5, color: line.color ?? INK, align: options.align });
  }

  return y;
}

/** The pages being laid out: where the next thing goes, and a new page when it does not fit. */
class Sheet {
  readonly doc: PdfDocument;
  page: PdfPage;
  y = MARGIN;
  /** A long text was cut to fit its place. */
  cut = false;

  constructor(
    info: { title: string; createdAt: Date },
    private readonly running: { left: string; right: string },
    private readonly footerHeight: number,
  ) {
    this.doc = new PdfDocument(info);
    this.page = this.doc.addPage();
  }

  get bottom(): number {
    return A4.height - MARGIN - this.footerHeight - 10;
  }

  /** A new page for what follows, with a short header that says which document it is. */
  next(): void {
    this.page = this.doc.addPage();
    // The name of the company gives way to the title of the document when the two do not fit side by side.
    const room = WIDTH - textWidth(this.running.right, 'regular', 9) - 16;
    let left = this.running.left;

    if (textWidth(left, 'bold', 9) > room) {
      while (left !== '' && textWidth(`${left}…`, 'bold', 9) > room) left = left.slice(0, -1).trimEnd();
      left = `${left}…`;
    }

    this.page.text(left, MARGIN, MARGIN + 6, { font: 'bold', size: 9, color: MUTED });
    this.page.text(this.running.right, RIGHT, MARGIN + 6, { size: 9, color: MUTED, align: 'right' });
    this.page.line(MARGIN, MARGIN + 12, RIGHT, MARGIN + 12, { color: RULE });
    this.y = MARGIN + 28;
  }

  /** Makes room for something `height` tall: a new page when it does not fit below. Returns whether a page was started. */
  ensure(height: number): boolean {
    if (this.y + height <= this.bottom) return false;

    this.next();

    return true;
  }
}

/** What goes at the foot of every page: the legal mentions, and the page number. */
function drawFooters(doc: PdfDocument, legal: string[]): void {
  const total = doc.pages.length;

  doc.pages.forEach((page, at) => {
    const top = A4.height - MARGIN - footerHeightOf(legal);

    page.line(MARGIN, top, RIGHT, top, { color: RULE });

    let y = top + 4;

    for (const line of legal) {
      y += 9.5;
      page.text(line, MARGIN, y - 2, { size: 7.5, color: FAINT });
    }

    page.text(`Page ${at + 1} / ${total}`, RIGHT, A4.height - MARGIN + 2, { size: 8, color: FAINT, align: 'right' });
  });
}

const footerHeightOf = (legal: string[]): number => 14 + legal.length * 9.5;

/** A bordered block with a small title (the customer, the job). Returns its height. */
function drawBox(page: PdfPage, x: number, top: number, width: number, height: number, title: string, lines: Line[]): void {
  page.rect(x, top, width, height, { stroke: RULE, lineWidth: 0.6 });
  page.text(title, x + 8, top + 14, { font: 'bold', size: 7.5, color: FAINT });
  drawLines(page, lines, x + 8, top + 18);
}

interface Company {
  name: string;
  address: string;
  phone: string;
  email: string;
  taxId: string;
  registre: string;
  rib: string;
}

const companyOf = (invoice: Row): Company => ({
  name: text(invoice.companyName),
  address: text(invoice.companyAddress),
  phone: text(invoice.companyPhone),
  email: text(invoice.companyEmail),
  taxId: text(invoice.companyTaxId),
  registre: text(invoice.companyRegistre),
  rib: text(invoice.companyRib),
});

/** The top of the first page: the company on the left, what the document is on the right. Returns where the page goes on. */
function drawMasthead(page: PdfPage, company: Company, head: { title: string; number: string; date: string; badge?: { text: string; color: string } }): number {
  const lines: Line[] = [];

  if (company.name) lines.push({ text: company.name, bold: true, size: 15 });
  if (company.address) lines.push({ text: company.address, color: MUTED, size: 9 });
  if (company.phone) lines.push({ text: `Tél. : ${company.phone}`, color: MUTED, size: 9 });
  if (company.email) lines.push({ text: company.email, color: MUTED, size: 9 });
  if (company.taxId) lines.push({ text: `MF : ${company.taxId}`, color: MUTED, size: 9 });
  if (company.registre) lines.push({ text: `RC : ${company.registre}`, color: MUTED, size: 9 });

  const leftEnd = drawLines(page, laidOut(lines, 280), MARGIN, MARGIN - 2);

  page.text(head.title, RIGHT, MARGIN + 20, { font: 'bold', size: 24, color: ACCENT, align: 'right' });
  page.text(`N° ${head.number}`, RIGHT, MARGIN + 40, { font: 'bold', size: 11, align: 'right' });
  page.text(`Date : ${head.date}`, RIGHT, MARGIN + 55, { size: 10, color: MUTED, align: 'right' });

  let rightEnd = MARGIN + 60;

  if (head.badge) {
    page.text(head.badge.text, RIGHT, MARGIN + 72, { font: 'bold', size: 10, color: head.badge.color, align: 'right' });
    rightEnd = MARGIN + 76;
  }

  return Math.max(leftEnd, rightEnd) + 16;
}

interface TableLine {
  label: string;
  description?: string;
  quantity: unknown;
  unitPrice: unknown;
  total: unknown;
}

function drawTableHead(sheet: Sheet, currency: string): void {
  const { page } = sheet;

  page.rect(MARGIN, sheet.y, WIDTH, 20, { fill: FILL });
  page.text('Désignation', MARGIN + 6, sheet.y + 13.5, { font: 'bold', size: 8.5, color: MUTED });
  page.text('Qté', COLUMN_QUANTITY_RIGHT, sheet.y + 13.5, { font: 'bold', size: 8.5, color: MUTED, align: 'right' });
  page.text(`Prix unit. HT (${currency})`, COLUMN_UNIT_RIGHT, sheet.y + 13.5, { font: 'bold', size: 8.5, color: MUTED, align: 'right' });
  page.text(`Total HT (${currency})`, COLUMN_TOTAL_RIGHT, sheet.y + 13.5, { font: 'bold', size: 8.5, color: MUTED, align: 'right' });
  sheet.y += 20;
}

/** The lines of the document: a row each, a new page (with the head of the table again) when one does not fit. */
function drawTable(sheet: Sheet, lines: TableLine[], currency: string): void {
  const number = (value: unknown) => formatMoney(value as never, { currency: false });

  sheet.ensure(20 + 40);
  drawTableHead(sheet, currency);

  for (const row of lines) {
    const cut = () => {
      sheet.cut = true;
    };
    const labelWidth = COLUMN_LABEL.width - 12;
    const label = limited(wrapText(row.label, labelWidth, 'regular', 9.5), MAX_LABEL_LINES, { width: labelWidth, font: 'regular', size: 9.5 }, cut);
    const description = row.description ? limited(wrapText(row.description, labelWidth, 'regular', 8), MAX_DESCRIPTION_LINES, { width: labelWidth, font: 'regular', size: 8 }, cut) : [];
    const height = 6 + label.length * 12.5 + description.length * 10.5 + 6;

    if (sheet.ensure(height)) drawTableHead(sheet, currency);

    const { page } = sheet;
    let y = sheet.y + 6;

    label.forEach((part, at) => page.text(part, MARGIN + 6, y + 9 + at * 12.5, { size: 9.5 }));
    y += label.length * 12.5;
    description.forEach((part, at) => page.text(part, MARGIN + 6, y + 8 + at * 10.5, { size: 8, color: FAINT }));

    page.text(plain(row.quantity), COLUMN_QUANTITY_RIGHT, sheet.y + 6 + 9, { size: 9.5, align: 'right' });
    page.text(number(row.unitPrice), COLUMN_UNIT_RIGHT, sheet.y + 6 + 9, { size: 9.5, align: 'right' });
    page.text(number(row.total), COLUMN_TOTAL_RIGHT, sheet.y + 6 + 9, { size: 9.5, align: 'right' });

    sheet.y += height;
    page.line(MARGIN, sheet.y, RIGHT, sheet.y, { color: RULE, width: 0.4 });
  }

  sheet.y += 12;
}

interface TotalRow {
  label: string;
  value: string;
  strong?: boolean;
  /** The row that ends the block: filled. */
  final?: boolean;
}

const TOTALS_LEFT = 325;
const TOTALS_ROW = 17;

/** The totals on the right and the amount in words on the left, kept together on one page. */
function drawTotals(sheet: Sheet, rows: TotalRow[], words: { title: string; text: string } | null): void {
  const wordLines = words ? laidOut([{ text: words.title, bold: true, size: 8.5, color: MUTED }, { text: capitalize(words.text), size: 10 }], TOTALS_LEFT - MARGIN - 20) : [];
  const height = Math.max(rows.length * TOTALS_ROW + 8, heightOf(wordLines) + 8);

  sheet.ensure(height);

  const { page } = sheet;
  let y = sheet.y;

  for (const row of rows) {
    if (row.final) {
      page.rect(TOTALS_LEFT, y, RIGHT - TOTALS_LEFT, TOTALS_ROW, { fill: ACCENT });
      page.text(row.label, TOTALS_LEFT + 8, y + 12, { font: 'bold', size: 10, color: '#ffffff' });
      page.text(row.value, RIGHT - 8, y + 12, { font: 'bold', size: 10, color: '#ffffff', align: 'right' });
    } else {
      page.text(row.label, TOTALS_LEFT + 8, y + 12, { font: row.strong ? 'bold' : 'regular', size: 9.5, color: row.strong ? INK : MUTED });
      page.text(row.value, RIGHT - 8, y + 12, { font: row.strong ? 'bold' : 'regular', size: 9.5, align: 'right' });
      page.line(TOTALS_LEFT, y + TOTALS_ROW, RIGHT, y + TOTALS_ROW, { color: RULE, width: 0.3 });
    }

    y += TOTALS_ROW;
  }

  if (wordLines.length > 0) drawLines(page, wordLines, MARGIN, sheet.y + 2);

  sheet.y += height + 10;
}

/** A paragraph under the totals, wrapped to the page; a new page when it does not fit. */
function drawNote(sheet: Sheet, lines: Line[]): void {
  const wrapped = laidOut(lines, WIDTH);

  sheet.ensure(heightOf(wrapped) + 6);
  sheet.y = drawLines(sheet.page, wrapped, MARGIN, sheet.y) + 8;
}

/** What the legal footer says, cut to the width of the page and to a number of lines; `cut` says when text was left out. */
function legalLinesOf(invoice: Row): { lines: string[]; cut: boolean } {
  const legal = text(invoice.legalMentions);
  let cut = false;

  if (legal === '') return { lines: [], cut };

  const lines = limited(wrapText(legal, WIDTH, 'regular', 7.5), MAX_LEGAL_LINES, { width: WIDTH, font: 'regular', size: 7.5 }, () => {
    cut = true;
  });

  return { lines, cut };
}

/** The day a document carries: when it was issued (an invoice from before the counter has no such day: when it was sent, then made). */
const dateOf = (document: Row): unknown => document.issuedAt ?? document.sentAt ?? document.createdAt;

const documentDate = (document: Row): Date => {
  const at = dateOf(document);
  const moment = at instanceof Date ? at : at === null || at === undefined ? new Date(0) : new Date(String(at));

  return Number.isNaN(moment.getTime()) ? new Date(0) : moment;
};

/** The invoice a person pays: its total with the stamp duty. */
export function invoiceTotalToPay(invoice: Row): number {
  return sumMoney(invoice.amountTTC, invoice.stampDuty ?? 0);
}

/**
 * The invoice as a PDF. `invoice` is the row as read from the database with its `items` and its `creditNotes`.
 * When something could not be put in the file (a character it cannot draw, a text cut to its place) the file is drawn again with a
 * line at its foot that says so.
 */
export function renderInvoicePdf(invoice: Row): RenderedPdf {
  const first = drawInvoice(invoice, false);

  return first.lossy ? drawInvoice(invoice, true) : first;
}

function drawInvoice(invoice: Row, notice: boolean): RenderedPdf {
  const currency = text(invoice.currency) || 'TND';
  const company = companyOf(invoice);
  const number = text(invoice.invoiceNumber);
  const stamp = money(invoice.stampDuty ?? 0);
  const totalToPay = invoiceTotalToPay(invoice);
  const creditNotes: Row[] = Array.isArray(invoice.creditNotes) ? [...invoice.creditNotes].sort((a, b) => Number(a.id) - Number(b.id)) : [];
  const legalMentions = legalLinesOf(invoice);
  const legal = legalMentions.lines;
  const status = String(invoice.status);

  const sheet = new Sheet(
    { title: `Facture ${number}`, createdAt: documentDate(invoice) },
    { left: company.name || 'Facture', right: `Facture ${number} (suite)` },
    footerHeightOf(legal),
  );

  sheet.cut = legalMentions.cut;

  const badge =
    status === 'CANCELLED' ? { text: 'ANNULÉE', color: BAD } : status === 'DRAFT' ? { text: 'BROUILLON', color: BAD } : status === 'PAID' ? { text: 'ACQUITTÉE', color: GOOD } : undefined;

  sheet.y = drawMasthead(sheet.page, company, { title: 'FACTURE', number, date: frenchDate(dateOf(invoice)), badge });

  // The customer and the job, side by side.
  const boxWidth = (WIDTH - 14) / 2;
  const client: Line[] = [{ text: text(invoice.clientName) || '—', bold: true, size: 10.5 }];

  if (text(invoice.clientAddress)) client.push({ text: text(invoice.clientAddress), color: MUTED });
  if (text(invoice.clientPhone)) client.push({ text: `Tél. : ${text(invoice.clientPhone)}`, color: MUTED });
  if (text(invoice.clientEmail)) client.push({ text: text(invoice.clientEmail), color: MUTED });
  if (text(invoice.clientTaxId)) client.push({ text: `MF : ${text(invoice.clientTaxId)}`, color: MUTED });

  const job: Line[] = [{ text: text(invoice.subServiceName) || serviceLabel(invoice.serviceType), bold: true, size: 10.5 }];

  if (text(invoice.interventionAddress) && text(invoice.interventionAddress) !== text(invoice.clientAddress)) {
    job.push({ text: `Lieu : ${text(invoice.interventionAddress)}`, color: MUTED });
  }

  const clientLines = laidOut(client, boxWidth - 16);
  const jobLines = laidOut(job, boxWidth - 16);
  const boxHeight = Math.max(heightOf(clientLines), heightOf(jobLines)) + 26;

  drawBox(sheet.page, MARGIN, sheet.y, boxWidth, boxHeight, 'FACTURÉ À', clientLines);
  drawBox(sheet.page, MARGIN + boxWidth + 14, sheet.y, boxWidth, boxHeight, 'INTERVENTION', jobLines);
  sheet.y += boxHeight + 18;

  const items: Row[] = Array.isArray(invoice.items) ? invoice.items : [];

  drawTable(
    sheet,
    items.length > 0
      ? items.map((item) => ({ label: text(item.label), description: text(item.description), quantity: item.quantity, unitPrice: item.unitPrice, total: item.total }))
      : [{ label: text(invoice.subServiceName) || serviceLabel(invoice.serviceType), quantity: 1, unitPrice: invoice.amountHT, total: invoice.amountHT }],
    currency,
  );

  const amount = (value: unknown) => formatMoney(value as never, { currency });
  const rows: TotalRow[] = [
    { label: 'Total HT', value: amount(invoice.amountHT) },
    { label: vatLabel(invoice.taxRate), value: amount(invoice.taxAmount) },
  ];
  const credited = money(invoice.creditedAmount ?? 0);
  // An invoice that is paid or cancelled asks for nothing: its total is what was billed, and what is left after the credit notes is the
  // net of the invoice (what is owed back to the customer for a paid one is a matter of the refund, which this file does not know).
  const asked = status !== 'PAID' && status !== 'CANCELLED';
  const dueLabel = asked ? 'Total à payer' : 'Total facturé';
  const netLabel = asked ? 'Net à payer' : 'Net de la facture';

  if (stamp > 0) {
    rows.push({ label: 'Total TTC', value: amount(invoice.amountTTC) });
    rows.push({ label: 'Timbre fiscal', value: amount(stamp) });
  }

  if (credited > 0) {
    rows.push({ label: stamp > 0 ? dueLabel : 'Total TTC', value: amount(totalToPay), strong: true });

    // Many credit notes on one invoice: the first ones are added up in one row so that the totals keep to a page.
    const summed = creditNotes.length > MAX_CREDIT_ROWS ? creditNotes.slice(0, creditNotes.length - (MAX_CREDIT_ROWS - 1)) : [];

    if (summed.length > 0) {
      const summedTotal = sumMoneyOf(summed.map((note) => sumMoney(note.amountTTC, note.stampDuty ?? 0)));

      rows.push({ label: `${summed.length} premiers avoirs`, value: `- ${amount(summedTotal)}` });
    }

    for (const note of creditNotes.slice(summed.length)) {
      const takenOff = amount(sumMoney(note.amountTTC, note.stampDuty ?? 0));

      rows.push({ label: `Avoir ${text(note.creditNoteNumber)}`, value: `- ${takenOff}` });
    }

    rows.push({ label: netLabel, value: amount(subtractMoney(totalToPay, credited)), final: true });
  } else {
    rows.push({ label: stamp > 0 ? dueLabel : 'Total TTC', value: amount(totalToPay), final: true });
  }

  const words = amountInWords(totalToPay, currency);

  drawTotals(sheet, rows, words ? { title: 'Arrêtée la présente facture à la somme de :', text: words } : null);

  // How it stands: paid, cancelled, or how to pay.
  if (status === 'PAID') {
    drawNote(sheet, [{ text: `Facture acquittée${invoice.paidAt ? ` le ${frenchDate(invoice.paidAt)}` : ''}.`, bold: true, color: GOOD, size: 10 }]);
  } else if (status === 'CANCELLED') {
    const notes = creditNotes.map((note) => text(note.creditNoteNumber)).filter(Boolean);

    drawNote(sheet, [
      { text: `Facture annulée${invoice.cancelledAt ? ` le ${frenchDate(invoice.cancelledAt)}` : ''}${notes.length > 0 ? ` (${notes.length > 1 ? 'avoirs' : 'avoir'} ${notes.join(', ')})` : ''}.`, bold: true, color: BAD, size: 10 },
    ]);
  }

  // The terms of payment the invoice was issued with stay on it whatever becomes of it; the account to pay into only while it asks for payment.
  const how: Line[] = [];

  if (text(invoice.paymentTerms)) how.push({ text: 'Conditions de règlement', bold: true, size: 9, color: MUTED }, { text: text(invoice.paymentTerms) });
  if (asked && company.rib) how.push({ text: `Coordonnées bancaires - RIB : ${company.rib}${company.name ? ` (${company.name})` : ''}` });

  if (how.length > 0) drawNote(sheet, how);

  // What the back office wrote for the customer when it made the invoice.
  if (text(invoice.notes)) drawNote(sheet, [{ text: 'Remarques', bold: true, size: 9, color: MUTED }, { text: text(invoice.notes) }]);

  if (notice) drawNote(sheet, [{ text: LOSSY_NOTICE, size: 8, color: FAINT }]);

  drawFooters(sheet.doc, legal);

  return { buffer: sheet.doc.render(), lossy: sheet.doc.lossy || sheet.cut };
}

/**
 * The credit note as a PDF. `invoice` is the invoice it takes back (with its `creditNotes`): the company and the customer on the
 * credit note are the ones the invoice kept.
 */
export function renderCreditNotePdf(creditNote: Row, invoice: Row): RenderedPdf {
  const first = drawCreditNote(creditNote, invoice, false);

  return first.lossy ? drawCreditNote(creditNote, invoice, true) : first;
}

function drawCreditNote(creditNote: Row, invoice: Row, notice: boolean): RenderedPdf {
  const currency = text(creditNote.currency) || text(invoice.currency) || 'TND';
  const company = companyOf(invoice);
  const number = text(creditNote.creditNoteNumber);
  const invoiceNumber = text(invoice.invoiceNumber);
  const stamp = money(creditNote.stampDuty ?? 0);
  const totalBack = sumMoney(creditNote.amountTTC, stamp);
  const legalMentions = legalLinesOf(invoice);
  const legal = legalMentions.lines;

  const sheet = new Sheet(
    { title: `Avoir ${number}`, createdAt: documentDate(creditNote) },
    { left: company.name || 'Avoir', right: `Avoir ${number} (suite)` },
    footerHeightOf(legal),
  );

  sheet.cut = legalMentions.cut;

  sheet.y = drawMasthead(sheet.page, company, { title: 'AVOIR', number, date: frenchDate(dateOf(creditNote)) });

  const boxWidth = (WIDTH - 14) / 2;
  const client: Line[] = [{ text: text(invoice.clientName) || '—', bold: true, size: 10.5 }];

  if (text(invoice.clientAddress)) client.push({ text: text(invoice.clientAddress), color: MUTED });
  if (text(invoice.clientPhone)) client.push({ text: `Tél. : ${text(invoice.clientPhone)}`, color: MUTED });
  if (text(invoice.clientEmail)) client.push({ text: text(invoice.clientEmail), color: MUTED });
  if (text(invoice.clientTaxId)) client.push({ text: `MF : ${text(invoice.clientTaxId)}`, color: MUTED });

  const reference: Line[] = [{ text: `Facture ${invoiceNumber}`, bold: true, size: 10.5 }];

  if (frenchDate(dateOf(invoice))) reference.push({ text: `du ${frenchDate(dateOf(invoice))}`, color: MUTED });
  reference.push({ text: text(invoice.subServiceName) || serviceLabel(invoice.serviceType), color: MUTED });

  const clientLines = laidOut(client, boxWidth - 16);
  const referenceLines = laidOut(reference, boxWidth - 16);
  const boxHeight = Math.max(heightOf(clientLines), heightOf(referenceLines)) + 26;

  drawBox(sheet.page, MARGIN, sheet.y, boxWidth, boxHeight, 'AVOIR ÉMIS À', clientLines);
  drawBox(sheet.page, MARGIN + boxWidth + 14, sheet.y, boxWidth, boxHeight, 'FACTURE CONCERNÉE', referenceLines);
  sheet.y += boxHeight + 18;

  drawTable(
    sheet,
    [{ label: `Avoir sur la facture ${invoiceNumber}`, description: `Motif : ${text(creditNote.reason)}`, quantity: 1, unitPrice: creditNote.amountHT, total: creditNote.amountHT }],
    currency,
  );

  const back = (value: unknown) => `- ${formatMoney(value as never, { currency })}`;
  const rows: TotalRow[] = [
    { label: 'Total HT', value: back(creditNote.amountHT) },
    { label: vatLabel(creditNote.taxRate), value: back(creditNote.taxAmount) },
  ];

  if (stamp > 0) {
    rows.push({ label: 'Total TTC', value: back(creditNote.amountTTC) });
    rows.push({ label: 'Timbre fiscal', value: back(stamp) });
  }

  rows.push({ label: stamp > 0 ? 'Total de l’avoir' : 'Total TTC', value: back(totalBack), final: true });

  const words = amountInWords(totalBack, currency);

  drawTotals(sheet, rows, words ? { title: 'Arrêté le présent avoir à la somme de :', text: words } : null);

  // What the invoice comes to after this credit note (and the ones before it).
  const earlier: Row[] = (Array.isArray(invoice.creditNotes) ? invoice.creditNotes : []).filter((note: Row) => Number(note.id) <= Number(creditNote.id));
  const creditedSoFar = sumMoneyOf(earlier.map((note) => sumMoney(note.amountTTC, note.stampDuty ?? 0)));
  const left = subtractMoney(invoiceTotalToPay(invoice), creditedSoFar);

  drawNote(sheet, [
    {
      text:
        left <= 0
          ? `Cet avoir annule la facture ${invoiceNumber} en totalité.`
          : `Cet avoir réduit la facture ${invoiceNumber} : son montant net est de ${formatMoney(left, { currency })}.`,
      bold: true,
      size: 10,
    },
  ]);

  if (notice) drawNote(sheet, [{ text: LOSSY_NOTICE, size: 8, color: FAINT }]);

  drawFooters(sheet.doc, legal);

  return { buffer: sheet.doc.render(), lossy: sheet.doc.lossy || sheet.cut };
}

/** The file name a download carries: "F-2026-0001.pdf". */
export function pdfFileName(number: string): string {
  const safe = String(number).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

  return `${safe || 'document'}.pdf`;
}
