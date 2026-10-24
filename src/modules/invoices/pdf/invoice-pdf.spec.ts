import { A4, textWidth } from './pdf-writer';
import { frenchDate, pdfFileName, renderCreditNotePdf, renderInvoicePdf } from './invoice-pdf';

interface Drawn {
  page: number;
  text: string;
  size: number;
  font: 'regular' | 'bold';
  x: number;
  /** Baseline, from the top of the page. */
  y: number;
}

const WIN_ANSI_BACK: Record<number, string> = { 0x80: '€', 0x85: '…', 0x92: '’', 0x96: '–', 0x9c: 'œ', 0x8c: 'Œ' };

/** Reads back every text the file draws (the streams are not compressed), in the order they were drawn. */
function drawnIn(buffer: Buffer): Drawn[] {
  const text = buffer.toString('latin1');
  const out: Drawn[] = [];
  const streams = [...text.matchAll(/<< \/Length \d+ >>\nstream\n([\s\S]*?)\nendstream/g)];

  streams.forEach((stream, page) => {
    for (const op of stream[1].matchAll(/\/(F1|F2) ([\d.]+) Tf 1 0 0 1 ([\d.-]+) ([\d.-]+) Tm \(((?:[^\\)]|\\.)*)\) Tj/g)) {
      const raw = op[5].replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8))).replace(/\\(.)/g, '$1');
      const decoded = [...raw].map((char) => WIN_ANSI_BACK[char.charCodeAt(0)] ?? char).join('');

      out.push({ page: page + 1, text: decoded, size: Number(op[2]), font: op[1] === 'F2' ? 'bold' : 'regular', x: Number(op[3]), y: A4.height - Number(op[4]) });
    }
  });

  return out;
}

const textsOf = (buffer: Buffer): string[] => drawnIn(buffer).map((drawn) => drawn.text);
const has = (buffer: Buffer, wanted: string): boolean => textsOf(buffer).includes(wanted);
const pagesOf = (buffer: Buffer): number => Number(/\/Count (\d+)/.exec(buffer.toString('latin1'))?.[1]);

const invoice = (extra: Record<string, unknown> = {}) => ({
  id: 7,
  invoiceNumber: 'F-2026-0007',
  status: 'SENT',
  currency: 'TND',
  companyName: 'Smart-Dépannage SARL',
  companyAddress: '12 Avenue Habib Bourguiba, 1001 Tunis',
  companyPhone: '+216 71 000 000',
  companyEmail: 'facturation@smart-depannage.tn',
  companyTaxId: '1234567/A/M/000',
  companyRegistre: 'B01234562026',
  companyRib: '08 006 0123456789012345 67',
  legalMentions: 'Société à responsabilité limitée au capital de 10 000 TND.',
  paymentTerms: 'Paiement à réception de la facture.',
  stampDuty: 1,
  clientName: 'Amine Ben Salah',
  clientAddress: '5 Rue de Marseille, La Marsa',
  clientPhone: '+216 22 123 456',
  clientEmail: 'amine@example.tn',
  clientTaxId: null,
  interventionAddress: '5 Rue de Marseille, La Marsa',
  serviceType: 'PLOMBIER',
  subServiceName: 'Réparation de fuite',
  amountHT: 100,
  taxRate: 19,
  taxAmount: 19,
  amountTTC: 119,
  creditedAmount: 0,
  issuedAt: new Date('2026-10-24T10:00:00Z'),
  cancelReason: 'Raison interne à ne pas imprimer',
  items: [
    { id: 1, label: 'Remplacement du siphon', description: 'Pièce et main d’œuvre', quantity: 1, unitPrice: 60, total: 60 },
    { id: 2, label: 'Joint et mastic', description: null, quantity: 2.5, unitPrice: 16, total: 40 },
  ],
  creditNotes: [] as Record<string, unknown>[],
  ...extra,
});

const note = (extra: Record<string, unknown> = {}) => ({
  id: 1,
  creditNoteNumber: 'AV-2026-0001',
  reason: 'Intervention annulée avant la fin des travaux',
  currency: 'TND',
  amountHT: 50,
  taxRate: 19,
  taxAmount: 9.5,
  amountTTC: 59.5,
  stampDuty: 0,
  issuedAt: new Date('2026-10-26T10:00:00Z'),
  ...extra,
});

describe('the invoice as a PDF (P2-07)', () => {
  describe('what it carries', () => {
    const { buffer, lossy } = renderInvoicePdf(invoice());

    it('is one A4 page, and every character was drawn', () => {
      expect(buffer.toString('latin1').startsWith('%PDF-1.4')).toBe(true);
      expect(pagesOf(buffer)).toBe(1);
      expect(lossy).toBe(false);
    });

    it('says it is an invoice, with its number and the date on the clock of the business', () => {
      expect(has(buffer, 'FACTURE')).toBe(true);
      expect(has(buffer, 'N° F-2026-0007')).toBe(true);
      expect(has(buffer, 'Date : 24/10/2026')).toBe(true);
    });

    it('carries the mentions of the company: name, address, phone, mail, matricule fiscal, trade register', () => {
      for (const wanted of ['Smart-Dépannage SARL', '12 Avenue Habib Bourguiba, 1001 Tunis', 'Tél. : +216 71 000 000', 'facturation@smart-depannage.tn', 'MF : 1234567/A/M/000', 'RC : B01234562026']) {
        expect(has(buffer, wanted)).toBe(true);
      }
    });

    it('carries the customer, and the job', () => {
      for (const wanted of ['Amine Ben Salah', '5 Rue de Marseille, La Marsa', 'Tél. : +216 22 123 456', 'amine@example.tn', 'Réparation de fuite']) {
        expect(has(buffer, wanted)).toBe(true);
      }
    });

    it('prints the matricule fiscal of a business customer only when there is one', () => {
      expect(textsOf(buffer).some((line) => line.startsWith('MF : ') && line !== 'MF : 1234567/A/M/000')).toBe(false);
      expect(has(renderInvoicePdf(invoice({ clientTaxId: '7654321/B/A/000' })).buffer, 'MF : 7654321/B/A/000')).toBe(true);
    });

    it('lists the lines with their quantity, unit price and total, and the description under the label', () => {
      for (const wanted of ['Remplacement du siphon', 'Pièce et main d’œuvre', 'Joint et mastic', '2,5', '60,000', '16,000', '40,000']) expect(has(buffer, wanted)).toBe(true);
    });

    it('gives the totals: without VAT, the VAT at its rate, with VAT, the stamp duty, the total to pay', () => {
      for (const wanted of ['Total HT', '100,000 TND', 'TVA 19 %', '19,000 TND', 'Total TTC', '119,000 TND', 'Timbre fiscal', '1,000 TND', 'Total à payer', '120,000 TND']) {
        expect(has(buffer, wanted)).toBe(true);
      }
    });

    it('writes the total to pay in words', () => {
      expect(has(buffer, 'Arrêtée la présente facture à la somme de :')).toBe(true);
      expect(has(buffer, 'Cent vingt dinars')).toBe(true);
    });

    it('says how to pay when it is not paid: the terms, and the bank account', () => {
      expect(has(buffer, 'Conditions de règlement')).toBe(true);
      expect(has(buffer, 'Paiement à réception de la facture.')).toBe(true);
      expect(has(buffer, 'Coordonnées bancaires - RIB : 08 006 0123456789012345 67 (Smart-Dépannage SARL)')).toBe(true);
    });

    it('carries the legal mentions at the foot of the page, with the page number', () => {
      expect(has(buffer, 'Société à responsabilité limitée au capital de 10 000 TND.')).toBe(true);
      expect(has(buffer, 'Page 1 / 1')).toBe(true);
    });

    it('is titled with the number', () => {
      expect(buffer.toString('latin1')).toContain('/Title (Facture F-2026-0007)');
    });
  });

  describe('the date', () => {
    it('is the date on the clock of Tunis, not of the server', () => {
      // 23:30 UTC on 31 December is already 1 January in Tunis (UTC+1).
      expect(has(renderInvoicePdf(invoice({ issuedAt: new Date('2026-12-31T23:30:00Z') })).buffer, 'Date : 01/01/2027')).toBe(true);
      expect(frenchDate(new Date('2026-12-31T22:30:00Z'))).toBe('31/12/2026');
      expect(frenchDate(null)).toBe('');
      expect(frenchDate('pas une date')).toBe('');
    });
  });

  describe('without stamp duty', () => {
    const { buffer } = renderInvoicePdf(invoice({ stampDuty: 0 }));

    it('has no line for it, and the total with VAT is the total to pay', () => {
      expect(has(buffer, 'Timbre fiscal')).toBe(false);
      expect(has(buffer, 'Total à payer')).toBe(false);
      expect(has(buffer, 'Total TTC')).toBe(true);
      expect(has(buffer, 'Cent dix-neuf dinars')).toBe(true);
    });
  });

  describe('with credit notes', () => {
    const credited = invoice({ creditedAmount: 59.5, creditNotes: [note()] });
    const { buffer } = renderInvoicePdf(credited);

    it('takes each credit note off, and ends on the net to pay', () => {
      expect(has(buffer, 'Total à payer')).toBe(true);
      expect(has(buffer, 'Avoir AV-2026-0001')).toBe(true);
      expect(has(buffer, '- 59,500 TND')).toBe(true);
      expect(has(buffer, 'Net à payer')).toBe(true);
      expect(has(buffer, '60,500 TND')).toBe(true);
    });

    it('still reads the total of the invoice as it was issued in words', () => {
      expect(has(buffer, 'Cent vingt dinars')).toBe(true);
    });

    it('lists the credit notes in the order they were made', () => {
      const two = invoice({
        creditedAmount: 79.5,
        creditNotes: [note({ id: 5, creditNoteNumber: 'AV-2026-0005' }), note({ id: 2, creditNoteNumber: 'AV-2026-0002', amountTTC: 20, amountHT: 16.807, taxAmount: 3.193 })],
      });
      const lines = textsOf(renderInvoicePdf(two).buffer).filter((line) => line.startsWith('Avoir '));

      expect(lines).toEqual(['Avoir AV-2026-0002', 'Avoir AV-2026-0005']);
    });
  });

  describe('how it stands', () => {
    it('says it was paid, and when, and no longer asks for payment: no account to pay into, but the terms it was issued with stay', () => {
      const { buffer } = renderInvoicePdf(invoice({ status: 'PAID', paidAt: new Date('2026-10-25T09:00:00Z') }));

      expect(has(buffer, 'ACQUITTÉE')).toBe(true);
      expect(has(buffer, 'Facture acquittée le 25/10/2026.')).toBe(true);
      expect(has(buffer, 'Conditions de règlement')).toBe(true);
      expect(has(buffer, 'Paiement à réception de la facture.')).toBe(true);
      expect(textsOf(buffer).some((line) => line.includes('RIB'))).toBe(false);
      expect(has(buffer, 'Total à payer')).toBe(false);
      expect(has(buffer, 'Total facturé')).toBe(true);
    });

    it('does not ask for the net of a paid invoice that a credit note lowered: it is the net of the invoice', () => {
      const { buffer } = renderInvoicePdf(invoice({ status: 'PAID', paidAt: new Date('2026-10-25T09:00:00Z'), creditedAmount: 59.5, creditNotes: [note()] }));

      expect(has(buffer, 'Net de la facture')).toBe(true);
      expect(has(buffer, '60,500 TND')).toBe(true);
      expect(has(buffer, 'Net à payer')).toBe(false);
      expect(has(buffer, 'Total à payer')).toBe(false);
      expect(has(buffer, 'Facture acquittée le 25/10/2026.')).toBe(true);
    });

    it('does not ask for the total of a cancelled invoice either', () => {
      const { buffer } = renderInvoicePdf(invoice({ status: 'CANCELLED', cancelledAt: new Date('2026-10-26T10:00:00Z') }));

      expect(has(buffer, 'ANNULÉE')).toBe(true);
      expect(has(buffer, 'Total à payer')).toBe(false);
      expect(has(buffer, 'Total facturé')).toBe(true);
      expect(textsOf(buffer).some((line) => line.includes('RIB'))).toBe(false);
      expect(has(buffer, 'Paiement à réception de la facture.')).toBe(true);
    });

    it('says it was cancelled, and by which credit note, and does not print the reason the back office wrote', () => {
      const { buffer } = renderInvoicePdf(
        invoice({ status: 'CANCELLED', cancelledAt: new Date('2026-10-26T10:00:00Z'), creditedAmount: 120, creditNotes: [note({ amountTTC: 119, stampDuty: 1 })] }),
      );

      expect(has(buffer, 'ANNULÉE')).toBe(true);
      expect(has(buffer, 'Facture annulée le 26/10/2026 (avoir AV-2026-0001).')).toBe(true);
      expect(has(buffer, 'Net de la facture')).toBe(true);
      expect(has(buffer, 'Net à payer')).toBe(false);
      expect(textsOf(buffer).join('|')).not.toContain('Raison interne');
    });

    it('is marked as a draft when it is one', () => {
      expect(has(renderInvoicePdf(invoice({ status: 'DRAFT' })).buffer, 'BROUILLON')).toBe(true);
    });

    it('does not mention how to pay when the company wrote neither terms nor bank account', () => {
      const { buffer } = renderInvoicePdf(invoice({ paymentTerms: null, companyRib: null }));

      expect(has(buffer, 'Conditions de règlement')).toBe(false);
      expect(textsOf(buffer).some((line) => line.includes('virement'))).toBe(false);
    });
  });

  describe('the notes', () => {
    it('prints what the back office wrote for the customer, and nothing when there is nothing', () => {
      const written = renderInvoicePdf(invoice({ notes: 'Merci pour votre confiance.' })).buffer;

      expect(has(written, 'Remarques')).toBe(true);
      expect(has(written, 'Merci pour votre confiance.')).toBe(true);
      expect(has(renderInvoicePdf(invoice({ notes: '  ' })).buffer, 'Remarques')).toBe(false);
      expect(has(renderInvoicePdf(invoice()).buffer, 'Remarques')).toBe(false);
    });
  });

  describe('what the company did not write', () => {
    it('prints no line for it, and no placeholder', () => {
      const { buffer } = renderInvoicePdf(invoice({ companyAddress: null, companyPhone: '', companyRegistre: null, companyTaxId: null, legalMentions: null }));
      const lines = textsOf(buffer);

      expect(lines.some((line) => line.startsWith('RC :') || line.startsWith('MF :') || line.startsWith('Tél. : +216 71'))).toBe(false);
      expect(lines.some((line) => /null|undefined/.test(line))).toBe(false);
      expect(has(buffer, 'Page 1 / 1')).toBe(true);
    });
  });

  describe('another currency', () => {
    it('writes the amounts in it, and no amount in words (the words are the dinars)', () => {
      const { buffer } = renderInvoicePdf(invoice({ currency: 'EUR', stampDuty: 0 }));

      expect(has(buffer, '119,000 EUR')).toBe(true);
      expect(has(buffer, 'Prix unit. HT (EUR)')).toBe(true);
      expect(textsOf(buffer).some((line) => line.startsWith('Arrêtée'))).toBe(false);
    });
  });

  describe('an invoice with no lines', () => {
    it('has one line for the service, at the amount without VAT', () => {
      const { buffer } = renderInvoicePdf(invoice({ items: [] }));

      expect(has(buffer, 'Réparation de fuite')).toBe(true);
      expect(has(buffer, '100,000')).toBe(true);
    });
  });

  describe('Arabic script', () => {
    it('is drawn as "?" and the file says it lost something', () => {
      const { buffer, lossy } = renderInvoicePdf(invoice({ clientName: 'محمد علي' }));

      expect(lossy).toBe(true);
      expect(has(buffer, '???? ???')).toBe(true);
    });
  });

  describe('the same document', () => {
    it('is the same bytes each time', () => {
      expect(renderInvoicePdf(invoice()).buffer.equals(renderInvoicePdf(invoice()).buffer)).toBe(true);
    });

    it('is not the same file when something it says is not the same', () => {
      expect(renderInvoicePdf(invoice()).buffer.equals(renderInvoicePdf(invoice({ amountHT: 101 })).buffer)).toBe(false);
    });
  });

  describe('a long description', () => {
    it('is cut where it is longer than the room it has, and says so', () => {
      const long = Array.from({ length: 400 }, (_, at) => `mot${at}`).join(' ');
      const lines = textsOf(renderInvoicePdf(invoice({ items: [{ id: 1, label: 'Ligne', description: long, quantity: 1, unitPrice: 100, total: 100 }] })).buffer);
      const description = lines.filter((line) => line.startsWith('mot'));

      expect(description.length).toBeLessThanOrEqual(30);
      expect(description[description.length - 1].endsWith('…')).toBe(true);
    });
  });

  describe('pages', () => {
    const many = (count: number) =>
      Array.from({ length: count }, (_, at) => ({
        id: at + 1,
        label: `Prestation numéro ${at + 1} ${'très '.repeat(at % 6)}détaillée`,
        description: at % 4 === 0 ? 'Détail de la prestation '.repeat(7) : null,
        quantity: at + 1,
        unitPrice: 12.345,
        total: (at + 1) * 12.345,
      }));

    it('goes on to other pages, each with the head of the table, its running header, the legal mentions and its number', () => {
      const { buffer } = renderInvoicePdf(invoice({ items: many(45) }));
      const drawn = drawnIn(buffer);
      const pages = pagesOf(buffer);

      expect(pages).toBeGreaterThan(2);

      for (let page = 1; page <= pages; page += 1) {
        const here = drawn.filter((entry) => entry.page === page).map((entry) => entry.text);

        expect(here).toContain('Société à responsabilité limitée au capital de 10 000 TND.');
        expect(here).toContain(`Page ${page} / ${pages}`);

        if (page > 1) expect(here).toContain('Facture F-2026-0007 (suite)');
        if (here.some((line) => line.startsWith('Prestation numéro'))) expect(here).toContain('Désignation');
      }
    });

    it('prints each line once, and the totals once', () => {
      const { buffer } = renderInvoicePdf(invoice({ items: many(45) }));
      const lines = textsOf(buffer);

      for (let at = 1; at <= 45; at += 1) expect(lines.filter((line) => line.startsWith(`Prestation numéro ${at} `)).length).toBeGreaterThanOrEqual(1);
      expect(lines.filter((line) => line === 'Total HT')).toHaveLength(1);
      expect(lines.filter((line) => line === 'Total à payer')).toHaveLength(1);
      expect(lines.filter((line) => line.startsWith('Arrêtée'))).toHaveLength(1);
    });

    it('never draws the lines, the totals or the notes over the legal mentions, whatever the number of lines and the length of the mentions', () => {
      let seed = 20261024;
      const random = (limit: number) => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;

        return seed % limit;
      };

      for (let round = 0; round < 60; round += 1) {
        const legalLength = [0, 80, 400, 1200, 2000][random(5)];
        const legal = legalLength === 0 ? null : Array.from({ length: Math.ceil(legalLength / 8) }, (_, at) => `mention${at}`).join(' ').slice(0, legalLength).trim();
        const count = random(70);
        const { buffer } = renderInvoicePdf(
          invoice({ items: many(count), legalMentions: legal, creditedAmount: round % 2 ? 10 : 0, creditNotes: round % 2 ? [note({ amountTTC: 10 })] : [] }),
        );
        const drawn = drawnIn(buffer);
        const pages = pagesOf(buffer);
        const legalLines = drawn.filter((entry) => entry.size === 7.5 && entry.font === 'regular');
        const perPage = Math.max(0, ...Array.from({ length: pages }, (_, at) => legalLines.filter((entry) => entry.page === at + 1).length));
        const footerTop = A4.height - 40 - (14 + perPage * 9.5);

        // The legal mentions are printed in full on every page.
        if (legal) {
          for (let page = 1; page <= pages; page += 1) {
            expect(legalLines.filter((entry) => entry.page === page).map((entry) => entry.text).join(' ')).toBe(legal);
          }
        }

        for (const entry of drawn) {
          if ((entry.size === 7.5 && entry.font === 'regular') || /^Page \d+ \/ \d+$/.test(entry.text)) continue;

          // The baseline is above the foot of the page, and a body text stays above the rule of the footer.
          expect(entry.y).toBeLessThan(footerTop);
        }

        expect(drawn.filter((entry) => entry.text === 'Total HT')).toHaveLength(1);
      }
    });
  });
});

describe('the credit note as a PDF (P2-07)', () => {
  const credited = invoice({ creditedAmount: 59.5, creditNotes: [note()] });
  const { buffer, lossy } = renderCreditNotePdf(note(), credited);

  it('says it is a credit note, with its number and date', () => {
    expect(lossy).toBe(false);
    expect(has(buffer, 'AVOIR')).toBe(true);
    expect(has(buffer, 'N° AV-2026-0001')).toBe(true);
    expect(has(buffer, 'Date : 26/10/2026')).toBe(true);
    expect(buffer.toString('latin1')).toContain('/Title (Avoir AV-2026-0001)');
  });

  it('carries the company and the customer of the invoice, and the legal mentions', () => {
    for (const wanted of ['Smart-Dépannage SARL', 'MF : 1234567/A/M/000', 'RC : B01234562026', 'Amine Ben Salah', 'Société à responsabilité limitée au capital de 10 000 TND.', 'Page 1 / 1']) {
      expect(has(buffer, wanted)).toBe(true);
    }
  });

  it('refers to the invoice it takes back, with its date, and says why', () => {
    expect(has(buffer, 'Facture F-2026-0007')).toBe(true);
    expect(has(buffer, 'du 24/10/2026')).toBe(true);
    expect(has(buffer, 'Avoir sur la facture F-2026-0007')).toBe(true);
    expect(has(buffer, 'Motif : Intervention annulée avant la fin des travaux')).toBe(true);
  });

  it('gives its amounts as taken off, and the total in words', () => {
    for (const wanted of ['- 50,000 TND', '- 9,500 TND', '- 59,500 TND', 'Cinquante-neuf dinars et cinq cents millimes']) expect(has(buffer, wanted)).toBe(true);
    expect(has(buffer, 'Arrêté le présent avoir à la somme de :')).toBe(true);
  });

  it('says what the invoice comes to after it (not what is left to pay: the credit note does not know the payments)', () => {
    expect(has(buffer, 'Cet avoir réduit la facture F-2026-0007 : son montant net est de 60,500 TND.')).toBe(true);
    expect(textsOf(buffer).some((line) => line.includes('à régler'))).toBe(false);
  });

  it('says it cancels the invoice when nothing is left to pay', () => {
    const closing = note({ amountTTC: 119, amountHT: 100, taxAmount: 19, stampDuty: 1 });
    const done = invoice({ status: 'CANCELLED', creditedAmount: 120, creditNotes: [closing] });
    const out = renderCreditNotePdf(closing, done).buffer;

    expect(has(out, 'Cet avoir annule la facture F-2026-0007 en totalité.')).toBe(true);
    expect(has(out, 'Timbre fiscal')).toBe(true);
    expect(has(out, '- 120,000 TND')).toBe(true);
    expect(has(out, 'Cent vingt dinars')).toBe(true);
  });

  it('reads what was left after this credit note, not after the ones that came later', () => {
    const first = note({ id: 1, creditNoteNumber: 'AV-2026-0001', amountTTC: 20, amountHT: 16.807, taxAmount: 3.193 });
    const second = note({ id: 2, creditNoteNumber: 'AV-2026-0002', amountTTC: 30, amountHT: 25.21, taxAmount: 4.79 });
    const both = invoice({ creditedAmount: 50, creditNotes: [first, second] });

    expect(has(renderCreditNotePdf(first, both).buffer, 'Cet avoir réduit la facture F-2026-0007 : son montant net est de 100,000 TND.')).toBe(true);
    expect(has(renderCreditNotePdf(second, both).buffer, 'Cet avoir réduit la facture F-2026-0007 : son montant net est de 70,000 TND.')).toBe(true);
  });

  it('is the same bytes each time', () => {
    expect(renderCreditNotePdf(note(), credited).buffer.equals(buffer)).toBe(true);
  });

  it('has no amount in words for another currency', () => {
    const out = renderCreditNotePdf(note({ currency: 'EUR' }), invoice({ currency: 'EUR', creditNotes: [note({ currency: 'EUR' })] })).buffer;

    expect(textsOf(out).some((line) => line.startsWith('Arrêté'))).toBe(false);
    expect(has(out, '- 59,500 EUR')).toBe(true);
  });
});

describe('the name of the file', () => {
  it('is the number of the document', () => {
    expect(pdfFileName('F-2026-0001')).toBe('F-2026-0001.pdf');
    expect(pdfFileName('AV-2026-0012')).toBe('AV-2026-0012.pdf');
  });

  it('keeps a header safe: no quote, no slash, no line break', () => {
    expect(pdfFileName('INV/2026 "x"\r\nSet-Cookie: a')).toBe('INV-2026-x-Set-Cookie-a.pdf');
    expect(pdfFileName('')).toBe('document.pdf');
    expect(pdfFileName('///')).toBe('document.pdf');
  });
});

describe('the invoice as a PDF, after the review (P2-07)', () => {
  const NOTICE = 'Certains caractères ou passages de ce document n’ont pas pu être reproduits dans ce PDF (écriture non latine, texte trop long).';

  describe('a text the file cannot reproduce', () => {
    it('is told at the foot of the file, once, when a character could not be drawn', () => {
      const out = renderInvoicePdf(invoice({ clientName: 'محمد علي' }));

      expect(out.lossy).toBe(true);
      expect(textsOf(out.buffer).filter((line) => line === NOTICE)).toHaveLength(1);
    });

    it('is told when a long text was cut to its place, and in the credit note too', () => {
      const long = Array.from({ length: 400 }, (_, at) => `mot${at}`).join(' ');
      const out = renderInvoicePdf(invoice({ items: [{ id: 1, label: 'Ligne', description: long, quantity: 1, unitPrice: 100, total: 100 }] }));

      expect(out.lossy).toBe(true);
      expect(textsOf(out.buffer)).toContain(NOTICE);

      const arabic = renderCreditNotePdf(note({ reason: 'سبب' }), invoice({ creditNotes: [note()] }));

      expect(arabic.lossy).toBe(true);
      expect(textsOf(arabic.buffer)).toContain(NOTICE);
    });

    it('cuts a long legal text to twenty lines at the foot of every page, with a "…" and the notice, in the invoice and in the credit note', () => {
      const lines = Array.from({ length: 87 }, (_, at) => `Mention ${at + 1} de la société.`);
      const legalMentions = lines.join('\n');
      const out = renderInvoicePdf(invoice({ legalMentions }));
      const footer = drawnIn(out.buffer).filter((drawn) => drawn.size === 7.5 && drawn.text.startsWith('Mention '));

      expect(out.lossy).toBe(true);
      expect(footer).toHaveLength(20);
      expect(footer[0].text).toBe('Mention 1 de la société.');
      expect(footer[19].text).toBe('Mention 20 de la société.…');
      expect(textsOf(out.buffer)).not.toContain('Mention 21 de la société.');
      expect(textsOf(out.buffer)).toContain(NOTICE);
      expect(pagesOf(out.buffer)).toBe(1);
      // the foot stays under the masthead: no line of the footer is drawn higher than the table of the lines
      expect(Math.min(...footer.map((drawn) => drawn.y))).toBeGreaterThan(A4.height - 40 - 14 - 20 * 9.5 - 1);

      const credit = renderCreditNotePdf(note(), invoice({ legalMentions, creditNotes: [note()] }));

      expect(credit.lossy).toBe(true);
      expect(drawnIn(credit.buffer).filter((drawn) => drawn.size === 7.5 && drawn.text.startsWith('Mention '))).toHaveLength(20);
      expect(pagesOf(credit.buffer)).toBe(1);
    });

    it('keeps a legal text of twenty lines whole, and says nothing', () => {
      const legalMentions = Array.from({ length: 20 }, (_, at) => `Mention ${at + 1} de la société.`).join('\n');
      const out = renderInvoicePdf(invoice({ legalMentions }));

      expect(out.lossy).toBe(false);
      expect(drawnIn(out.buffer).filter((drawn) => drawn.size === 7.5 && drawn.text.startsWith('Mention '))).toHaveLength(20);
      expect(textsOf(out.buffer)).not.toContain(NOTICE);
    });

    it('says nothing when everything was drawn', () => {
      expect(textsOf(renderInvoicePdf(invoice()).buffer)).not.toContain(NOTICE);
      expect(textsOf(renderCreditNotePdf(note(), invoice({ creditNotes: [note()] })).buffer)).not.toContain(NOTICE);
    });

    it('keeps the notice off the legal mentions and the totals (it is a note under them, on a page of its own when it must)', () => {
      const out = renderInvoicePdf(invoice({ clientName: 'محمد', items: Array.from({ length: 30 }, (_, at) => ({ id: at, label: `Ligne ${at}`, quantity: 1, unitPrice: 1, total: 1 })) }));

      expect(textsOf(out.buffer).filter((line) => line === NOTICE)).toHaveLength(1);
      expect(pagesOf(out.buffer)).toBeGreaterThanOrEqual(1);
    });
  });

  describe('a long text', () => {
    it('does not take longer to draw as it grows (a word of thousands of characters used to block the server for seconds)', () => {
      const word = 'x'.repeat(4000);
      const started = Date.now();

      renderInvoicePdf(invoice({ items: [{ id: 1, label: word, description: word, quantity: 1, unitPrice: 100, total: 100 }], notes: word, legalMentions: word.slice(0, 2000) }));

      expect(Date.now() - started).toBeLessThan(1500);

      const huge = 'y'.repeat(100000);
      const hugeStarted = Date.now();

      renderInvoicePdf(invoice({ items: [{ id: 1, label: huge, description: huge, quantity: 1, unitPrice: 100, total: 100 }] }));

      expect(Date.now() - hugeStarted).toBeLessThan(3000);
    });

    it('is cut where the word stops fitting, and nothing of it is lost between the lines', () => {
      const word = 'abcdefghij'.repeat(30);
      const lines = textsOf(renderInvoicePdf(invoice({ items: [{ id: 1, label: word, quantity: 1, unitPrice: 100, total: 100 }] })).buffer).filter((line) => /^[a-j]+$/.test(line));

      expect(lines.join('')).toBe(word);
      expect(lines.length).toBeGreaterThan(1);
    });

    it('keeps a long name of the company off the running header of the next pages', () => {
      const name = 'Société Tunisienne de Dépannage et de Maintenance des Installations Domestiques et Industrielles SARL';
      const out = renderInvoicePdf(invoice({ companyName: name, items: Array.from({ length: 60 }, (_, at) => ({ id: at, label: `Prestation ${at}`, quantity: 1, unitPrice: 1, total: 1 })) }));
      const second = drawnIn(out.buffer).filter((entry) => entry.page === 2 && entry.y < 60);
      const left = second.find((entry) => entry.font === 'bold');
      const right = second.find((entry) => entry.text === 'Facture F-2026-0007 (suite)');

      expect(left).toBeDefined();
      expect(right).toBeDefined();
      expect((left as any).x + textWidth((left as any).text, 'bold', 9)).toBeLessThan((right as any).x);
      expect((left as any).text.endsWith('…')).toBe(true);
    });
  });

  describe('the terms and the account', () => {
    it('print the terms on every state, the account only while payment is asked', () => {
      for (const status of ['DRAFT', 'ISSUED', 'SENT', 'OVERDUE']) {
        const { buffer } = renderInvoicePdf(invoice({ status }));

        expect(has(buffer, 'Paiement à réception de la facture.')).toBe(true);
        expect(textsOf(buffer).some((line) => line.includes('RIB'))).toBe(true);
      }

      for (const status of ['PAID', 'CANCELLED']) {
        const { buffer } = renderInvoicePdf(invoice({ status }));

        expect(has(buffer, 'Paiement à réception de la facture.')).toBe(true);
        expect(textsOf(buffer).some((line) => line.includes('RIB'))).toBe(false);
      }
    });

    it('do not say how the customer pays: the account is given as the account of the company', () => {
      expect(textsOf(renderInvoicePdf(invoice()).buffer).some((line) => line.includes('Règlement par virement'))).toBe(false);
    });
  });

  describe('credit notes', () => {
    it('are named in the plural when a cancelled invoice has several', () => {
      const out = renderInvoicePdf(
        invoice({ status: 'CANCELLED', cancelledAt: new Date('2026-10-27T10:00:00Z'), creditedAmount: 120, creditNotes: [note({ id: 1, amountTTC: 20 }), note({ id: 2, creditNoteNumber: 'AV-2026-0002', amountTTC: 99, stampDuty: 1 })] }),
      );

      expect(has(out.buffer, 'Facture annulée le 27/10/2026 (avoirs AV-2026-0001, AV-2026-0002).')).toBe(true);
    });

    it('stay on the page, with the first ones added up, when an invoice has dozens of them', () => {
      const notes = Array.from({ length: 40 }, (_, at) => note({ id: at + 1, creditNoteNumber: `AV-2026-${String(at + 1).padStart(4, '0')}`, amountTTC: 1, amountHT: 0.84, taxAmount: 0.16 }));
      const { buffer } = renderInvoicePdf(invoice({ creditedAmount: 40, creditNotes: notes }));
      const drawn = drawnIn(buffer);
      const footerTop = A4.height - 40 - (14 + 1 * 9.5);

      expect(has(buffer, '29 premiers avoirs')).toBe(true);
      expect(has(buffer, '- 29,000 TND')).toBe(true);
      expect(has(buffer, 'Avoir AV-2026-0040')).toBe(true);
      expect(has(buffer, 'Avoir AV-2026-0001')).toBe(false);
      expect(has(buffer, 'Net à payer')).toBe(true);
      expect(has(buffer, '80,000 TND')).toBe(true);

      for (const entry of drawn) {
        if ((entry.size === 7.5 && entry.font === 'regular') || /^Page \d+ \/ \d+$/.test(entry.text)) continue;
        expect(entry.y).toBeLessThan(footerTop);
      }
    });

    it('lists them one by one up to the number that fits', () => {
      const notes = Array.from({ length: 12 }, (_, at) => note({ id: at + 1, creditNoteNumber: `AV-2026-${String(at + 1).padStart(4, '0')}`, amountTTC: 1, amountHT: 0.84, taxAmount: 0.16 }));
      const { buffer } = renderInvoicePdf(invoice({ creditedAmount: 12, creditNotes: notes }));

      expect(textsOf(buffer).filter((line) => line.startsWith('Avoir AV-'))).toHaveLength(12);
      expect(textsOf(buffer).some((line) => line.includes('premiers avoirs'))).toBe(false);
    });
  });

  describe('the amount in words', () => {
    it('says "de" for whole millions: "Un million de dinars"', () => {
      const out = renderInvoicePdf(invoice({ amountHT: 840336.134, taxAmount: 159663.866, amountTTC: 1000000, stampDuty: 0 }));

      expect(has(out.buffer, 'Un million de dinars')).toBe(true);
    });
  });

  describe('the small things', () => {
    it('does not draw a soft hyphen, and reads a lone carriage return as a space (neither is a lost character)', () => {
      const out = renderInvoicePdf(invoice({ clientName: 'Amine\u00adBen\rSalah' }));

      expect(out.lossy).toBe(false);
      expect(has(out.buffer, 'AmineBen Salah')).toBe(true);
    });

    it('dates an invoice from before the counter by the day it was sent when it has no day of issue', () => {
      const out = renderInvoicePdf(invoice({ issuedAt: null, sentAt: new Date('2026-09-02T10:00:00Z'), createdAt: new Date('2026-08-01T10:00:00Z') }));

      expect(has(out.buffer, 'Date : 02/09/2026')).toBe(true);
    });

    it('does not borrow the day of today for a document that has no date at all: the file is the same whenever it is drawn', () => {
      const dateless = invoice({ issuedAt: null, sentAt: null, createdAt: null });
      const out = renderInvoicePdf(dateless);

      expect(out.buffer.toString('latin1')).toContain('D:19700101');
      expect(textsOf(out.buffer).filter((line) => line.startsWith('Date :')).every((line) => line.trim() === 'Date :')).toBe(true);
      expect(renderInvoicePdf(dateless).buffer.equals(out.buffer)).toBe(true);
    });

    it('writes the VAT line without a rate when the invoice has none, not with a hole', () => {
      const out = renderInvoicePdf(invoice({ taxRate: null }));

      expect(has(out.buffer, 'TVA')).toBe(true);
      expect(textsOf(out.buffer).some((line) => line.includes('TVA  %'))).toBe(false);
    });
  });
});
