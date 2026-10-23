import { NotFoundException } from '@nestjs/common';

import { leaked, leakedTo, nestedJob, poisonedPayment, secret } from '../../common/testing/poison';
import { PaymentsService } from './payments.service';

/** The customer's own details on their invoice. */
const OWN_INVOICE = ['invoice.clientEmail', 'invoice.clientPhone', 'invoice.clientAddress'];

/**
 * P1-08: what the routes of the payments answer to the customer and to the artisan, and what the
 * timeline says when the back office fails, cancels or refunds a payment. A secret is planted in
 * the payment, in the job, the quote and the invoice inside it.
 */
function makeWorld(payment: Record<string, unknown> = {}) {
  const events: any[] = [];
  const created: any[] = [];

  const prisma: any = {
    payment: {
      create: async ({ data }: any) => {
        created.push(data);

        return poisonedPayment({ ...data, id: 9 });
      },
      findMany: async () => [poisonedPayment(), poisonedPayment({ id: 2 })],
      findUnique: async () => poisonedPayment(payment),
      update: async ({ data }: any) => poisonedPayment({ ...payment, ...data }),
    },
    intervention: {
      findUnique: async () => ({ ...nestedJob(), status: 'COMPLETED', quotes: [{ id: 1, amountTTC: 120, status: 'ACCEPTED' }], invoice: null }),
      update: async ({ data }: any) => ({ ...nestedJob(), ...data }),
    },
    invoice: { findUnique: async () => ({ id: 1, interventionId: 1, amountTTC: 120 }) },
  };
  const eventsService: any = { create: async (event: any) => events.push(event) };
  const notifications: any = { notifyPaymentReceived: async () => undefined };

  return { service: new PaymentsService(prisma, eventsService, notifications), events, created };
}

describe('the payments a customer reads (P1-08)', () => {
  it('a payment request: the payment as the customer may read it, with the instructions', async () => {
    const answer: any = await makeWorld().service.createClientPaymentRequest(10, 1, { method: 'CASH', invoiceId: 1 } as any);

    expect(leakedTo(answer, 'client', OWN_INVOICE)).toEqual([]);
    expect(answer.amount).toBe(120);
    expect(typeof answer.instructions).toBe('string');
    expect(answer).not.toHaveProperty('adminNote');
    expect(answer.intervention.artisan).toEqual({ id: 20, name: 'Ali', phone: '+21621111111' });
  });

  it('the payments of a job: the customer\'s copy, the job, the quote and the invoice inside', async () => {
    const answer: any[] = await makeWorld().service.findForClient(10, 1);

    expect(answer.length).toBe(2);

    for (const payment of answer) {
      expect(leakedTo(payment, 'client', OWN_INVOICE)).toEqual([]);
      expect(payment).not.toHaveProperty('providerPaymentId');
      expect(payment).not.toHaveProperty('failureReason');
      expect(payment.invoice).not.toHaveProperty('emailedTo');
      expect(payment.quote).not.toHaveProperty('createdById');
    }
  });

  it('a payment of somebody else\'s job is not listed', async () => {
    await expect(makeWorld().service.findForClient(99, 1)).rejects.toBeInstanceOf(Error);
  });
});

describe('the receipt (P1-08)', () => {
  it('the customer: the payment in their copy, the artisan\'s name and number, no e-mail of the artisan', async () => {
    const answer: any = await makeWorld().service.generateReceipt(1, { id: 10, role: 'CLIENT' as any });

    expect(leakedTo(answer, 'client', OWN_INVOICE)).toEqual([]);
    expect(answer.receipt.client).toEqual({ id: 10, name: 'Salah', email: 'salah@example.tn', phone: '+21620000000' });
    expect(answer.receipt.artisan).toEqual({ id: 20, name: 'Ali', phone: '+21621111111' });
    expect(answer.receipt.method).toBe('CASH');
  });

  it('the artisan: the customer to reach, what was paid but not how the customer paid', async () => {
    const answer: any = await makeWorld().service.generateReceipt(1, { id: 20, role: 'ARTISAN' as any });

    expect(leakedTo(answer, 'artisan')).toEqual([]);
    expect(answer.receipt.client.phone).toBe('+21620000000');
    expect(answer.receipt.artisan.email).toBe(secret('artisan.email'));
    expect(answer.receipt).not.toHaveProperty('method');
    expect(answer.receipt).not.toHaveProperty('provider');
    expect(answer.receipt).not.toHaveProperty('reference');
    expect(answer.payment).not.toHaveProperty('method');
    expect(answer.receipt.amount).toBe(120);
  });

  it('the back office reads the rows as they are', async () => {
    const answer: any = await makeWorld().service.generateReceipt(1, { id: 5, role: 'ACCOUNTANT' as any });

    expect(answer.payment.adminNote).toBe(secret('payment.adminNote'));
    expect(answer.receipt.artisan.email).toBe(secret('artisan.email'));
  });

  it('somebody who is nobody on this job finds nothing', async () => {
    await expect(makeWorld().service.generateReceipt(1, { id: 99, role: 'CLIENT' as any })).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('what the timeline says when the back office fails, cancels or refunds a payment (P1-08)', () => {
  const note = 'Le client doit 50 TND de plus, ne pas rembourser sans appeler Sam';

  it('a fixed line, with the staff\'s words kept in the data that only the back office reads', async () => {
    const failing = makeWorld({ status: 'PENDING' });
    const cancelling = makeWorld({ status: 'PENDING' });
    const refunding = makeWorld({ status: 'PAID' });

    await failing.service.fail(1, 5, { reason: note, adminNote: note } as any);
    await cancelling.service.cancel(1, 5, { reason: note, adminNote: note } as any);
    await refunding.service.refund(1, 5, { reason: note, adminNote: note, amount: 20 } as any);

    for (const event of [...failing.events, ...cancelling.events, ...refunding.events]) {
      expect(JSON.stringify([event.title, event.message])).not.toContain(note);
      expect(event.metadata.reason).toBe(note);
    }

    expect([failing.events.length, cancelling.events.length, refunding.events.length]).toEqual([1, 1, 1]);
    expect(failing.events[0].message).toBe('Le paiement a échoué.');
    expect(cancelling.events[0].message).toBe('Le paiement a été annulé.');
    expect(refunding.events[0].message).toBe('Remboursement de 20,000 TND.');
  });

  it('without a reason typed, the lines are the same', async () => {
    const world = makeWorld();

    await world.service.refund(1, 5, { amount: 20 } as any);

    expect(world.events[0].message).toBe('Remboursement de 20,000 TND.');
  });
});
