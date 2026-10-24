/**
 * The invoice and the credit note as files to send (P2-07): the PDF, the name it is saved under, and how it is sent.
 */
import { pdfFileName, renderCreditNotePdf, renderInvoicePdf } from './invoice-pdf';

type Row = Record<string, any>;

export interface PdfFile {
  buffer: Buffer;
  filename: string;
}

export const invoicePdfFile = (invoice: Row): PdfFile => ({ buffer: renderInvoicePdf(invoice).buffer, filename: pdfFileName(String(invoice.invoiceNumber)) });

export const creditNotePdfFile = (creditNote: Row, invoice: Row): PdfFile => ({
  buffer: renderCreditNotePdf(creditNote, invoice).buffer,
  filename: pdfFileName(String(creditNote.creditNoteNumber)),
});

/** What the response of a PDF says besides the bytes: opened in the browser, not kept by a cache or a proxy (it is the customer's document), not read as anything else. */
export function sendPdf(res: { setHeader(name: string, value: string): unknown; send(body: Buffer): unknown }, file: PdfFile): void {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${file.filename}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(file.buffer);
}
