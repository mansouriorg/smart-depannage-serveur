import { PdfDocument, textWidth, winAnsi, wrapText, A4 } from './pdf-writer';

const at = new Date('2026-10-24T10:00:00Z');

/** The file as text (it is plain ASCII but for the header bytes): enough to read the structure back. */
const asText = (buffer: Buffer): string => buffer.toString('latin1');

describe('the PDF writer (P2-07)', () => {
  describe('the characters', () => {
    it('writes the French accents as the bytes of Windows-1252', () => {
      const { bytes, lossy } = winAnsi('é è à ç ô î œ ’ « » – € °');

      expect(lossy).toBe(false);
      expect(bytes).toEqual([0xe9, 0x20, 0xe8, 0x20, 0xe0, 0x20, 0xe7, 0x20, 0xf4, 0x20, 0xee, 0x20, 0x9c, 0x20, 0x92, 0x20, 0xab, 0x20, 0xbb, 0x20, 0x96, 0x20, 0x80, 0x20, 0xb0]);
    });

    it('writes the narrow spaces that a formatted amount may carry as plain spaces', () => {
      expect(winAnsi('1 234 567').bytes).toEqual([0x31, 0x20, 0x32, 0x33, 0x34, 0xa0, 0x35, 0x36, 0x37]);
    });

    it('draws what it cannot (Arabic) as "?" and says so', () => {
      const { bytes, lossy } = winAnsi('محمد');

      expect(lossy).toBe(true);
      expect(bytes).toEqual([0x3f, 0x3f, 0x3f, 0x3f]);
    });

    it('leaves out the characters that have no width', () => {
      expect(winAnsi('a​b﻿c').bytes).toEqual([0x61, 0x62, 0x63]);
    });

    it('does not draw a soft hyphen (it shows only at a break), and reads a lone carriage return and the line and paragraph separators as spaces', () => {
      expect(winAnsi('ab\u00adc')).toEqual({ bytes: [0x61, 0x62, 0x63], lossy: false });
      expect(winAnsi('a\rb\u2028c\u2029d')).toEqual({ bytes: [0x61, 0x20, 0x62, 0x20, 0x63, 0x20, 0x64], lossy: false });
    });

    it('knows that a page which draws "?" for a missing character is lossy', () => {
      const document = new PdfDocument({ title: 'x', createdAt: at });

      document.addPage().text('abc', 10, 10);
      expect(document.lossy).toBe(false);

      document.addPage().text('محمد', 10, 30);
      expect(document.lossy).toBe(true);
    });
  });

  describe('the widths', () => {
    it('measures with the metrics of Helvetica and Helvetica-Bold', () => {
      // H 722, e 556, l 222, l 222, o 556 = 2278 per 1000.
      expect(textWidth('Hello', 'regular', 10)).toBeCloseTo(22.78, 5);
      // H 722, e 556, l 278, l 278, o 611 = 2445.
      expect(textWidth('Hello', 'bold', 10)).toBeCloseTo(24.45, 5);
      expect(textWidth('', 'regular', 10)).toBe(0);
    });

    it('grows with the size', () => {
      expect(textWidth('Facture', 'regular', 20)).toBeCloseTo(textWidth('Facture', 'regular', 10) * 2, 8);
    });
  });

  describe('wrapping', () => {
    it('keeps a short text on a line', () => {
      expect(wrapText('Bonjour tout le monde', 500, 'regular', 10)).toEqual(['Bonjour tout le monde']);
    });

    it('cuts at the spaces, so that no line is wider than the width', () => {
      const lines = wrapText('un deux trois quatre cinq six sept huit neuf dix onze douze', 80, 'regular', 10);

      expect(lines.length).toBeGreaterThan(2);
      for (const line of lines) expect(textWidth(line, 'regular', 10)).toBeLessThanOrEqual(80);
      expect(lines.join(' ')).toBe('un deux trois quatre cinq six sept huit neuf dix onze douze');
    });

    it('cuts a word that is wider than the line, and loses no letter', () => {
      const word = 'x'.repeat(120);
      const lines = wrapText(word, 60, 'regular', 10);

      for (const line of lines) expect(textWidth(line, 'regular', 10)).toBeLessThanOrEqual(60);
      expect(lines.join('')).toBe(word);
    });

    it('cuts a word of thousands of letters in one pass: the time grows with the length, not with its cube', () => {
      const started = Date.now();
      const lines = wrapText('z'.repeat(200000), 60, 'regular', 10);

      expect(Date.now() - started).toBeLessThan(3000);
      expect(lines.join('')).toBe('z'.repeat(200000));
      for (const line of lines) expect(textWidth(line, 'regular', 10)).toBeLessThanOrEqual(60);
    });

    it('cuts a word between two characters, never inside an emoji or another character of two code units', () => {
      const lines = wrapText('a😀'.repeat(40), 30, 'regular', 10);

      expect(lines.join('')).toBe('a😀'.repeat(40));
      for (const line of lines) expect(/[\ud800-\udbff]$/.test(line) || /^[\udc00-\udfff]/.test(line)).toBe(false);
    });

    it('starts a line at a line break, and keeps an empty one', () => {
      expect(wrapText('a\nb\n\nc', 500, 'regular', 10)).toEqual(['a', 'b', '', 'c']);
      expect(wrapText('a\r\nb', 500, 'regular', 10)).toEqual(['a', 'b']);
    });
  });

  describe('the file', () => {
    function sample(): Buffer {
      const document = new PdfDocument({ title: 'Facture F-2026-0001', createdAt: at });
      const page = document.addPage();

      page.text('Facture (n° 1) \\ é', 40, 60, { font: 'bold', size: 14 });
      page.text('Total', 555, 100, { align: 'right' });
      page.line(40, 110, 555, 110);
      page.rect(40, 120, 100, 20, { fill: '#f1f5f9', stroke: '#cbd5e1' });
      document.addPage().text('Page 2', 40, 60);

      return document.render();
    }

    it('is a PDF: a header, its objects, a table of their places and an end', () => {
      const text = asText(sample());

      expect(text.startsWith('%PDF-1.4')).toBe(true);
      expect(text.endsWith('%%EOF\n')).toBe(true);
      expect(text).toContain('/Count 2');
      expect(text).toContain('/BaseFont /Helvetica-Bold');
      expect(text).toContain('/Encoding /WinAnsiEncoding');
      expect(text).toContain('/MediaBox [0 0 595.28 841.89]');
    });

    it('has a table of places that points at each object', () => {
      const buffer = sample();
      const text = asText(buffer);
      const start = Number(/startxref\n(\d+)\n%%EOF/.exec(text)?.[1]);

      expect(text.slice(start, start + 4)).toBe('xref');

      const table = text.slice(start).split('\n');
      const [first, count] = table[1].split(' ').map(Number);

      expect(first).toBe(0);
      expect(table[2]).toBe('0000000000 65535 f ');

      for (let id = 1; id < count; id += 1) {
        const entry = table[2 + id];
        const offset = Number(entry.slice(0, 10));

        expect(entry.slice(10)).toBe(' 00000 n ');
        expect(text.slice(offset, offset + `${id} 0 obj`.length)).toBe(`${id} 0 obj`);
      }

      expect(text).toContain(`/Size ${count}`);
    });

    it('states the length of each stream as it is', () => {
      const text = asText(sample());
      const streams = [...text.matchAll(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)];

      expect(streams).toHaveLength(2);
      for (const [, length, body] of streams) expect(Buffer.byteLength(body, 'latin1')).toBe(Number(length));
    });

    it('escapes what a string cannot hold, and writes the accents as octal codes', () => {
      const text = asText(sample());

      expect(text).toContain('(Facture \\(n\\260 1\\) \\\\ \\351) Tj');
    });

    it('draws the text from the top of the page, right-aligned when asked', () => {
      const text = asText(sample());

      // 841.89 - 60 = 781.89 for the first baseline.
      expect(text).toContain('1 0 0 1 40 781.89 Tm');
      // "Total" is 5 characters at 10 pt: T 611, o 556, t 278, a 556, l 222 = 2223 -> 22.23 wide; its right edge is 555.
      expect(text).toContain('1 0 0 1 532.77 741.89 Tm (Total) Tj');
    });

    it('is the same bytes for the same drawing, and other bytes for another one', () => {
      expect(sample().equals(sample())).toBe(true);

      const other = new PdfDocument({ title: 'Facture F-2026-0001', createdAt: at });

      other.addPage().text('autre', 40, 60);
      expect(other.render().equals(sample())).toBe(false);
    });

    it('carries the title and the date of the document, not the date of today', () => {
      const text = asText(sample());

      expect(text).toContain('/Title (Facture F-2026-0001)');
      expect(text).toContain('/CreationDate (D:20261024100000Z)');
    });

    it('is a page when nothing was drawn', () => {
      const text = asText(new PdfDocument({ title: 'vide', createdAt: at }).render());

      expect(text).toContain('/Count 1');
    });

    it('refuses a color that is not #rrggbb', () => {
      const page = new PdfDocument({ title: 'x', createdAt: at }).addPage();

      expect(() => page.text('a', 1, 1, { color: 'red' })).toThrow('not a color');
    });

    it('has an A4 page', () => {
      expect(A4.width).toBeCloseTo(595.28, 2);
      expect(A4.height).toBeCloseTo(841.89, 2);
    });
  });
});
