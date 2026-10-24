/**
 * A small PDF writer (P2-07): text, lines and rectangles on A4 pages, in the two standard fonts every reader has (Helvetica and
 * Helvetica-Bold). No package: an invoice is a few lines of text and a table, and this keeps the server free of a PDF engine to
 * install, update and trust.
 *
 *  - The bytes depend only on what is drawn and on the date given for the document: the same invoice gives the same file, each time.
 *  - Text is written in WinAnsiEncoding (Windows-1252: the French accents, the euro sign, the typographic quotes and dashes). A
 *    character outside it is drawn as "?" and the document says so (`lossy`): Arabic script, for one, is not drawn.
 *  - Coordinates are in points (1/72 inch) from the top left of the page, and `y` of a text is its baseline.
 */
import { createHash } from 'crypto';

import { HELVETICA_BOLD_WIDTHS, HELVETICA_WIDTHS } from './helvetica-widths';

export const A4 = { width: 595.28, height: 841.89 } as const;

export type PdfFont = 'regular' | 'bold';

/** The characters of Windows-1252 that are not the same code in Latin-1 (codes 128 to 159). */
const WIN_ANSI_EXTRA: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/** Spaces of other widths and the hyphens that do not break a line are drawn as their plain cousins. */
const PLAIN: Record<number, number> = {
  0x202f: 0x20, 0x2009: 0x20, 0x2007: 0x20, 0x2002: 0x20, 0x2003: 0x20, 0x2011: 0x2d, 0x2212: 0x2d, 0x0009: 0x20, 0x000d: 0x20, 0x2028: 0x20, 0x2029: 0x20,
};

export interface EncodedText {
  bytes: number[];
  /** A character that could not be drawn was replaced by "?". */
  lossy: boolean;
}

/** The text as bytes of WinAnsiEncoding. Line breaks are not text: the layout cuts lines before it draws them. */
export function winAnsi(text: string): EncodedText {
  const bytes: number[] = [];
  let lossy = false;

  for (const char of text.normalize('NFC')) {
    const code = char.codePointAt(0) as number;

    if (code === 0x200b || code === 0x200c || code === 0x200d || code === 0xfeff || code === 0x00ad) continue; // zero-width, and the hyphen that shows only at a break
    else if (code in PLAIN) bytes.push(PLAIN[code]);
    else if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) bytes.push(code);
    else if (code in WIN_ANSI_EXTRA) bytes.push(WIN_ANSI_EXTRA[code]);
    else {
      bytes.push(0x3f);
      lossy = true;
    }
  }

  return { bytes, lossy };
}

/** How wide the text is when drawn, in points. */
export function textWidth(text: string, font: PdfFont, size: number): number {
  const table = font === 'bold' ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  let total = 0;

  for (const byte of winAnsi(text).bytes) total += table[byte - 32] ?? 278;

  return (total * size) / 1000;
}

/** The text cut into lines no wider than `width`: at the spaces, and inside a word only when the word alone is wider. A "\n" starts a line. */
export function wrapText(text: string, width: number, font: PdfFont, size: number): string[] {
  const lines: string[] = [];

  for (const paragraph of String(text).split(/\r?\n/)) {
    const words = paragraph.split(/ +/).filter((word) => word !== '');
    let line = '';

    if (words.length === 0) {
      lines.push('');
      continue;
    }

    for (const word of words) {
      const candidate = line === '' ? word : `${line} ${word}`;

      if (textWidth(candidate, font, size) <= width) {
        line = candidate;
        continue;
      }

      if (line !== '') lines.push(line);

      // A word wider than the line: cut it where it stops fitting, in one pass over its characters.
      let piece = '';
      let pieceWidth = 0;

      for (const char of word.normalize('NFC')) {
        const charWidth = textWidth(char, font, size);

        if (piece !== '' && pieceWidth + charWidth > width) {
          lines.push(piece);
          piece = '';
          pieceWidth = 0;
        }

        piece += char;
        pieceWidth += charWidth;
      }

      line = piece;
    }

    lines.push(line);
  }

  return lines;
}

const num = (value: number): string => {
  const text = value.toFixed(2);

  return text.replace(/\.?0+$/, '') || '0';
};

function colorOf(hex: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);

  if (!match) throw new Error(`pdf: ${hex} is not a color like #1e293b`);

  const value = parseInt(match[1], 16);

  return [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((part) => num(part / 255)).join(' ');
}

/** A text as a PDF string: parentheses and backslashes escaped, anything outside printable ASCII as an octal code. */
function pdfString(bytes: number[]): string {
  let out = '(';

  for (const byte of bytes) {
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out += `\\${String.fromCharCode(byte)}`;
    else if (byte < 0x20 || byte > 0x7e) out += `\\${byte.toString(8).padStart(3, '0')}`;
    else out += String.fromCharCode(byte);
  }

  return `${out})`;
}

export interface TextStyle {
  font?: PdfFont;
  size?: number;
  color?: string;
  /** "right": `x` is the right edge of the text. */
  align?: 'left' | 'right';
}

export class PdfPage {
  private readonly operations: string[] = [];

  constructor(private readonly document: PdfDocument) {}

  /** Draws one line of text with its baseline at `y` (from the top of the page). */
  text(text: string, x: number, y: number, style: TextStyle = {}): void {
    const font = style.font ?? 'regular';
    const size = style.size ?? 10;
    const encoded = winAnsi(text);

    if (encoded.lossy) this.document.lossy = true;
    if (encoded.bytes.length === 0) return;

    const left = style.align === 'right' ? x - textWidth(text, font, size) : x;

    this.operations.push(
      `${colorOf(style.color ?? '#111827')} rg BT /${font === 'bold' ? 'F2' : 'F1'} ${num(size)} Tf 1 0 0 1 ${num(left)} ${num(A4.height - y)} Tm ${pdfString(encoded.bytes)} Tj ET`,
    );
  }

  line(x1: number, y1: number, x2: number, y2: number, style: { width?: number; color?: string } = {}): void {
    this.operations.push(`${colorOf(style.color ?? '#cbd5e1')} RG ${num(style.width ?? 0.5)} w ${num(x1)} ${num(A4.height - y1)} m ${num(x2)} ${num(A4.height - y2)} l S`);
  }

  rect(x: number, y: number, width: number, height: number, style: { fill?: string; stroke?: string; lineWidth?: number } = {}): void {
    const parts: string[] = [];

    if (style.fill) parts.push(`${colorOf(style.fill)} rg`);
    if (style.stroke) parts.push(`${colorOf(style.stroke)} RG ${num(style.lineWidth ?? 0.5)} w`);

    parts.push(`${num(x)} ${num(A4.height - y - height)} ${num(width)} ${num(height)} re ${style.fill && style.stroke ? 'B' : style.fill ? 'f' : 'S'}`);
    this.operations.push(parts.join(' '));
  }

  content(): string {
    return this.operations.join('\n');
  }
}

export class PdfDocument {
  readonly pages: PdfPage[] = [];
  /** Some text had a character the fonts cannot draw. */
  lossy = false;

  constructor(private readonly info: { title: string; createdAt: Date }) {}

  addPage(): PdfPage {
    const page = new PdfPage(this);

    this.pages.push(page);

    return page;
  }

  /** The file. At least one page. */
  render(): Buffer {
    if (this.pages.length === 0) this.addPage();

    // Objects: 1 catalog, 2 pages, 3 and 4 fonts, 5 info; then a content stream and a page for each page.
    const objects: string[] = [];
    const kids: number[] = [];

    objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
    objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';

    const created = this.info.createdAt.toISOString().replace(/[-:T]/g, '').slice(0, 14);

    objects[5] = `<< /Title ${pdfString(winAnsi(this.info.title).bytes)} /Producer (Smart-Depannage) /CreationDate (D:${created}Z) >>`;

    this.pages.forEach((page, at) => {
      const content = page.content();
      const streamId = 6 + at * 2;
      const pageId = streamId + 1;

      objects[streamId] = `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`;
      objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${streamId} 0 R >>`;
      kids.push(pageId);
    });

    objects[2] = `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(' ')}] /Count ${kids.length} >>`;

    let out = '%PDF-1.4\n%âãÏÓ\n';
    const offsets: number[] = [];

    for (let id = 1; id < objects.length; id += 1) {
      offsets[id] = Buffer.byteLength(out, 'latin1');
      out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
    }

    const xref = Buffer.byteLength(out, 'latin1');
    const fileId = createHash('md5').update(`${this.info.title}|${created}|${this.pages.map((page) => page.content()).join('\n')}`).digest('hex');

    out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
    for (let id = 1; id < objects.length; id += 1) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
    out += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info 5 0 R /ID [<${fileId}> <${fileId}>] >>\nstartxref\n${xref}\n%%EOF\n`;

    return Buffer.from(out, 'latin1');
  }
}
