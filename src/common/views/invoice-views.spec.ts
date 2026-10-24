import {
  creditNoteView,
  currentInvoice,
  interventionForArtisan,
  interventionForBoard,
  interventionForClient,
  interventionForRoom,
  interventionForTracking,
  invoiceForArtisan,
  invoiceForClient,
} from './views';

/** What each reader sees of the invoices of a job, with the credit notes and the invoice that replaced a cancelled one (P2-07). */
const invoice = (id: number, status = 'ISSUED', extra: Record<string, unknown> = {}) => ({
  id,
  interventionId: 5,
  invoiceNumber: `F-2026-${String(id).padStart(4, '0')}`,
  status,
  paymentStatus: 'PENDING',
  companyName: 'Smart-Dépannage SARL',
  companyRegistre: 'B01234562026',
  companyRib: '08006012345678901234',
  legalMentions: 'SARL au capital de 10 000 TND.',
  paymentTerms: 'Paiement à réception.',
  stampDuty: 1,
  creditedAmount: 0,
  mentionsConfirmed: true,
  cancelReason: 'raison interne',
  clientName: 'Amine',
  clientTaxId: '7654321/B/A/000',
  clientEmail: 'amine@example.tn',
  amountHT: 100,
  taxRate: 19,
  taxAmount: 19,
  amountTTC: 119,
  ...extra,
});

const note = (id = 1, extra: Record<string, unknown> = {}) => ({
  id,
  invoiceId: 1,
  interventionId: 5,
  creditNoteNumber: `AV-2026-000${id}`,
  reason: 'Remise',
  currency: 'TND',
  amountHT: 16.667,
  taxRate: 19,
  taxAmount: 3.333,
  amountTTC: 20,
  stampDuty: 0,
  issuedAt: new Date('2026-10-25T09:00:00Z'),
  createdAt: new Date('2026-10-25T09:00:00Z'),
  createdById: 99,
  createdBy: { id: 99, name: 'Comptable' },
  ...extra,
});

describe('the invoice a job shows', () => {
  it('is the newest one that is not cancelled', () => {
    expect(currentInvoice([invoice(1, 'CANCELLED'), invoice(2), invoice(3, 'CANCELLED')])?.id).toBe(2);
    expect(currentInvoice([invoice(2), invoice(1, 'PAID')])?.id).toBe(2);
    expect(currentInvoice([invoice(1), invoice(3, 'PAID'), invoice(2)])?.id).toBe(3);
  });

  it('is the newest one when all were cancelled: the customer is told it was cancelled', () => {
    expect(currentInvoice([invoice(1, 'CANCELLED'), invoice(2, 'CANCELLED')])?.id).toBe(2);
  });

  it('is nothing for a job with no invoice, or when the list is not there', () => {
    expect(currentInvoice([])).toBeNull();
    expect(currentInvoice(null)).toBeNull();
    expect(currentInvoice(undefined)).toBeNull();
  });

  it('does not reorder the list it is given', () => {
    const list = [invoice(1), invoice(3), invoice(2)];

    currentInvoice(list);
    expect(list.map((row) => row.id)).toEqual([1, 3, 2]);
  });
});

describe('a credit note as it is read', () => {
  it('carries what it takes back and why, never who wrote it', () => {
    const view = creditNoteView(note());

    expect(Object.keys(view).sort()).toEqual(['amountHT', 'amountTTC', 'createdAt', 'creditNoteNumber', 'currency', 'id', 'interventionId', 'invoiceId', 'issuedAt', 'reason', 'stampDuty', 'taxAmount', 'taxRate']);
    expect(view).not.toHaveProperty('createdById');
    expect(view).not.toHaveProperty('createdBy');
  });

  it('is nothing for nothing', () => {
    expect(creditNoteView(null)).toBeNull();
    expect(creditNoteView(undefined)).toBeUndefined();
  });
});

describe('the invoice with its credit notes', () => {
  it('the customer reads the mentions, the tax number and the credit notes, never the internal reason or the confirmation', () => {
    const view: any = invoiceForClient(invoice(1, 'ISSUED', { creditNotes: [note()] }));

    expect([view.companyRegistre, view.companyRib, view.legalMentions, view.paymentTerms, Number(view.stampDuty), view.clientTaxId]).toEqual([
      'B01234562026',
      '08006012345678901234',
      'SARL au capital de 10 000 TND.',
      'Paiement à réception.',
      1,
      '7654321/B/A/000',
    ]);
    expect(view.creditNotes).toHaveLength(1);
    expect(view.creditNotes[0]).not.toHaveProperty('createdById');
    expect(view).not.toHaveProperty('cancelReason');
    expect(view).not.toHaveProperty('mentionsConfirmed');
  });

  it('the artisan reads the same document without the customer\'s details and without their tax number', () => {
    const view: any = invoiceForArtisan(invoice(1, 'ISSUED', { creditNotes: [note()] }));

    expect(view.companyRegistre).toBe('B01234562026');
    expect(view.creditNotes).toHaveLength(1);
    expect(view).not.toHaveProperty('clientTaxId');
    expect(view).not.toHaveProperty('clientEmail');
    expect(view).not.toHaveProperty('cancelReason');
    expect(view).not.toHaveProperty('mentionsConfirmed');
  });

  it('the artisan reads what a credit note took back, not why, and no file of the invoice; the customer reads both', () => {
    const withFile = invoice(1, 'ISSUED', { pdfUrl: '/files/9/download', creditNotes: [note()] });
    const theirs: any = invoiceForArtisan(withFile);
    const mine: any = invoiceForClient(withFile);

    expect(theirs.creditNotes[0]).not.toHaveProperty('reason');
    expect(theirs.creditNotes[0]).toMatchObject({ creditNoteNumber: 'AV-2026-0001', amountTTC: 20 });
    expect(theirs).not.toHaveProperty('pdfUrl');
    expect(mine.creditNotes[0].reason).toBe('Remise');
    expect(mine.pdfUrl).toBe('/files/9/download');
  });

  it('the credit notes are left out when the invoice was read without them', () => {
    expect(invoiceForClient(invoice(1))).not.toHaveProperty('creditNotes');
    expect(invoiceForArtisan(invoice(1))).not.toHaveProperty('creditNotes');
  });

  it('a draft shows nothing, with or without credit notes', () => {
    expect(invoiceForClient(invoice(1, 'DRAFT', { creditNotes: [note()] }))).toBeNull();
    expect(invoiceForArtisan(invoice(1, 'DRAFT', { creditNotes: [note()] }))).toBeNull();
  });
});

describe('a job read with the list of its invoices', () => {
  const job = (invoices: unknown[]) => ({ id: 5, clientId: 3, status: 'COMPLETED', invoices });

  it('shows the customer, the visitor and the artisan the current invoice as "invoice", and never the list', () => {
    const list = [invoice(1, 'CANCELLED', { creditNotes: [note()] }), invoice(2)];

    for (const view of [interventionForClient(job(list)), interventionForTracking(job(list)), interventionForArtisan(job(list))] as any[]) {
      expect(view.invoice.id).toBe(2);
      expect(view).not.toHaveProperty('invoices');
    }
  });

  it('shows the cancelled invoice when it is the only one, and null when there is none', () => {
    expect((interventionForClient(job([invoice(1, 'CANCELLED')])) as any).invoice.status).toBe('CANCELLED');
    expect((interventionForClient(job([])) as any).invoice).toBeNull();
    expect((interventionForTracking(job([])) as any).invoice).toBeNull();
    expect((interventionForArtisan(job([])) as any).invoice).toBeNull();
  });

  it('shows a draft to nobody: a job whose only invoice is a draft has none', () => {
    expect((interventionForClient(job([invoice(1, 'DRAFT')])) as any).invoice).toBeNull();
    expect((interventionForTracking(job([invoice(1, 'DRAFT')])) as any).invoice).toBeNull();
    expect((interventionForArtisan(job([invoice(1, 'DRAFT')])) as any).invoice).toBeNull();
  });

  it('still reads a job that carries one "invoice" and no list', () => {
    expect((interventionForClient({ id: 5, clientId: 3, status: 'COMPLETED', invoice: invoice(4) }) as any).invoice.id).toBe(4);
    expect((interventionForTracking({ id: 5, status: 'COMPLETED', invoice: invoice(4) }) as any).invoice.id).toBe(4);
  });

  it('says nothing of invoices when the job was read without them', () => {
    expect(interventionForClient({ id: 5, clientId: 3, status: 'COMPLETED' })).not.toHaveProperty('invoice');
    expect(interventionForTracking({ id: 5, status: 'COMPLETED' })).not.toHaveProperty('invoice');
  });

  it('keeps the invoices off the board and out of the live room', () => {
    const list = [invoice(1)];

    expect(JSON.stringify(interventionForBoard(job(list)))).not.toContain('F-2026');
    expect(JSON.stringify(interventionForRoom(job(list)))).not.toContain('F-2026');
  });
});
