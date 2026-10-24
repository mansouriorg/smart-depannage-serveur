import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { matchesWhere } from '../../common/testing/fake-tables';
import { leakedTo, nestedJob, poisonedInvoice, secret } from '../../common/testing/poison';
import { buildWorld } from '../../common/testing/world';
import { InvoicesService } from './invoices.service';

/**
 * P1-08: what the routes of the invoices answer to the customer and to the artisan. A secret is
 * planted in the invoice, in the payments on it and in the job inside it.
 */
const OWN_INVOICE = ['invoice.clientEmail', 'invoice.clientPhone', 'invoice.clientAddress'];

function makeWorld() {
  const asked: any[] = [];
  const events: any[] = [];
  const invoices = () => [
    poisonedInvoice({ id: 1, interventionId: 1 }),
    poisonedInvoice({ id: 2, interventionId: 2, status: 'DRAFT', invoiceNumber: secret('invoice.draft.number'), intervention: nestedJob({ id: 2 }) }),
  ];

  const prisma: any = {
    invoice: {
      findUnique: async ({ where }: any) =>
        invoices().find((invoice) => (where.id !== undefined ? invoice.id === where.id : invoice.interventionId === where.interventionId)) ?? null,
      findMany: async (args: any) => {
        asked.push(args);

        return invoices()
          .filter((invoice) => matchesWhere(invoice, args.where?.status ? { status: args.where.status } : {}))
          .filter((invoice) => args.where?.interventionId === undefined || invoice.interventionId === args.where.interventionId);
      },
      update: async ({ data }: any) => ({ ...invoices()[0], ...data }),
    },
    creditNote: {
      findUnique: async ({ where }: any) => {
        const note = { id: 1, invoiceId: 1, interventionId: 1, creditNoteNumber: 'AV-2026-0001', reason: 'Erreur', currency: 'TND', amountHT: 10, taxRate: 20, taxAmount: 2, amountTTC: 12, stampDuty: 0, issuedAt: new Date('2026-10-26T10:00:00Z') };

        return where.id === 1 ? { ...note, invoice: invoices()[0] } : null;
      },
    },
  };
  const eventsService: any = { create: async (event: any) => events.push(event) };

  return { service: new InvoicesService(prisma, eventsService, {} as any), asked, events };
}

const client = { id: 10, role: 'CLIENT' as any };
const artisan = { id: 20, role: 'ARTISAN' as any };

describe('the invoices a customer reads (P1-08)', () => {
  it('my invoices: the ones that are out of draft, asked of the database that way, in the customer\'s copy', async () => {
    const world = makeWorld();
    const answer: any[] = await world.service.findMine(10);

    expect(world.asked[0].where.status).toEqual({ not: 'DRAFT' });
    expect(world.asked[0].where.intervention).toEqual({ clientId: 10 });
    expect(answer.map((invoice) => invoice.id)).toEqual([1]);
    expect(leakedTo(answer, 'client', OWN_INVOICE)).toEqual([]);
    expect(answer[0]).not.toHaveProperty('emailedTo');
    expect(answer[0]).not.toHaveProperty('cancelReason');
    expect(answer[0].payments[0]).not.toHaveProperty('adminNote');
  });

  it('one invoice, by its number or by its job, and its download: the customer\'s copy', async () => {
    const world = makeWorld();
    const one: any = await world.service.findOneForClient(10, 1);
    const general: any = await world.service.findOne({ id: 10, role: 'CLIENT' as any }, 1);
    const byJob: any = await world.service.findByIntervention({ id: 10, role: 'CLIENT' as any }, 1);
    const download: any = await world.service.downloadForClient(10, 1);
    const downloadGeneral: any = await world.service.downloadInvoice({ id: 10, role: 'CLIENT' as any }, 1);

    for (const answer of [one, general, byJob, download, downloadGeneral]) {
      expect(leakedTo(answer, 'client', OWN_INVOICE)).toEqual([]);
    }

    expect(one.clientEmail).toBe(secret('invoice.clientEmail'));
    expect(download.invoiceNumber).toBe('F-2026-1');
    expect(download.invoice.id).toBe(1);
    expect(downloadGeneral.invoice.id).toBe(1);
    // The PDF is drawn from the invoice, and the answer says where to ask for it.
    expect(download.pdfPath).toBe('/invoices/1/pdf');
    expect(downloadGeneral.pdfPath).toBe('/invoices/1/pdf');
  });

  it('a draft is not the customer\'s yet: not found, by any route', async () => {
    const world = makeWorld();

    await expect(world.service.findOneForClient(10, 2)).rejects.toBeInstanceOf(NotFoundException);
    await expect(world.service.findOne({ id: 10, role: 'CLIENT' as any }, 2)).rejects.toBeInstanceOf(NotFoundException);
    await expect(world.service.findByIntervention({ id: 10, role: 'CLIENT' as any }, 2)).rejects.toBeInstanceOf(NotFoundException);
    await expect(world.service.downloadForClient(10, 2)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('somebody else\'s invoice is refused', async () => {
    await expect(makeWorld().service.findOneForClient(99, 1)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(makeWorld().service.findOne({ id: 99, role: 'CLIENT' as any }, 1)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('the invoices an artisan reads (P1-08)', () => {
  it('the invoice of their job: what it says, not the customer\'s details on it, not how the customer paid', async () => {
    const world = makeWorld();

    for (const answer of [
      await world.service.findOne(artisan, 1),
      await world.service.findByIntervention(artisan, 1),
      (await world.service.downloadInvoice(artisan, 1)).invoice,
    ] as any[]) {
      expect(leakedTo(answer, 'artisan')).toEqual([]);
      expect(answer).not.toHaveProperty('clientEmail');
      expect(answer).not.toHaveProperty('clientPhone');
      expect(answer).not.toHaveProperty('clientAddress');
      expect(answer.payments[0]).not.toHaveProperty('method');
      expect(answer.amountTTC).toBe(120);
    }
  });

  it('is not given the link to the PDF, which carries the customer\'s details: it is the customer\'s and the back office\'s', async () => {
    const world = makeWorld();
    const download: any = await world.service.downloadInvoice(artisan, 1);

    expect(download.pdfPath).toBeNull();
    expect(download.message).toContain('réservé au client et à l’administration');
    await expect(world.service.pdfOfInvoice(artisan, 1)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(world.service.pdfOfCreditNote(artisan, 1)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a draft is not shown to them either', async () => {
    await expect(makeWorld().service.findOne(artisan, 2)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('the back office and the invoices (P1-08)', () => {
  it('reads every invoice as it is, drafts and the record of the e-mails included', async () => {
    const world = makeWorld();
    const draft: any = await world.service.findOne({ id: 5, role: 'ACCOUNTANT' as any }, 2);
    const sent: any = await world.service.findOne({ id: 5, role: 'SUPPORT' as any }, 1);

    expect(draft.invoiceNumber).toBe(secret('invoice.draft.number'));
    expect(sent.emailedTo).toBe(secret('invoice.emailedTo'));
  });

  it('a cancelled invoice: the line the customer reads is fixed, the reason stays in the data', async () => {
    const w = buildWorld();
    const invoiceId = w.ids.A.invoice;

    await w.svc.invoices.cancelInvoice({ id: w.people.accountant.id, role: 'ACCOUNTANT' as any }, invoiceId, { reason: 'Client mauvais payeur, ne plus relancer' });

    const line = w.memory.rows('interventionEvent').find((event) => event.type === 'CANCELLED' && event.metadata?.invoiceId === invoiceId);

    expect(line).toBeDefined();
    expect(String(line?.message)).toMatch(/^La facture .+ a été annulée\.$/);
    expect(JSON.stringify([line?.title, line?.message])).not.toContain('mauvais payeur');
    expect(line?.metadata.reason).toBe('Client mauvais payeur, ne plus relancer');
  });
});
