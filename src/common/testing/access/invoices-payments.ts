import { Scenario, SelfScenario } from '../access-matrix';
import { Household, World, mark } from '../world';

const job = (h: Household, w: World) => w.ids[h].intervention;
const invoice = (h: Household, w: World) => w.ids[h].invoice;
/** The payment the seed holds (online, waiting) is out of the way: a job has one open payment at a time (P2-03). */
const noOpenPayment = (w: World) => w.set('payment', { status: 'CANCELLED', cancelledAt: new Date('2026-01-02T00:00:00Z') });
const paid = (w: World) => w.set('payment', { status: 'PAID', confirmedAt: new Date('2026-01-02T00:00:00Z') });

/** What neither the customer nor the artisan may read on an invoice, and what the artisan may not read of the customer. */
const hiddenOnInvoice = (h: Household, person: { role: string }) => [
  mark(h, 'Invoice.emailedTo'),
  mark(h, 'Invoice.cancelReason'),
  // The artisan is not the customer: not their details on the invoice (nor their tax number), no file of the invoice, and a credit note without
  // its reason (written for the customer).
  ...(person.role === 'ARTISAN'
    ? [
        mark(h, 'Invoice.clientEmail'),
        mark(h, 'Invoice.clientPhone'),
        mark(h, 'Invoice.clientAddress'),
        mark(h, 'Invoice.clientTaxId'),
        mark(h, 'Invoice.pdfUrl'),
        mark(h, 'CreditNote.reason'),
      ]
    : []),
];

export const invoiceScenarios: Scenario[] = [
  {
    route: 'GET /invoices/intervention/:',
    note: 'the invoice of a job: the customer, the artisan of the job, the back office',
    allowed: ['client', 'artisan', 'backOffice'],
    reads: true,
    request: (h, w) => ({ params: { interventionId: job(h, w) } }),
    hidden: (h, person) => (person.role === 'CLIENT' || person.role === 'ARTISAN' ? hiddenOnInvoice(h, person) : []),
  },
  {
    route: 'GET /invoices/client/:',
    allowed: ['client'],
    reads: true,
    request: (h, w) => ({ params: { invoiceId: invoice(h, w) } }),
    hidden: (h, person) => hiddenOnInvoice(h, person),
  },
  {
    route: 'GET /invoices/client/:/download',
    allowed: ['client'],
    reads: true,
    request: (h, w) => ({ params: { invoiceId: invoice(h, w) } }),
    hidden: (h, person) => hiddenOnInvoice(h, person),
  },
  {
    route: 'GET /invoices/:/download',
    allowed: ['client', 'artisan', 'backOffice'],
    reads: true,
    request: (h, w) => ({ params: { invoiceId: invoice(h, w) } }),
    hidden: (h, person) => (person.role === 'CLIENT' || person.role === 'ARTISAN' ? hiddenOnInvoice(h, person) : []),
  },
  {
    route: 'GET /invoices/:',
    allowed: ['client', 'artisan', 'backOffice'],
    reads: true,
    request: (h, w) => ({ params: { invoiceId: invoice(h, w) } }),
    hidden: (h, person) => (person.role === 'CLIENT' || person.role === 'ARTISAN' ? hiddenOnInvoice(h, person) : []),
  },
  {
    route: 'GET /invoices/:/pdf',
    note: 'the PDF carries the customer\'s details: the customer and the back office have it, the artisan of the job does not (P2-07)',
    allowed: ['client', 'backOffice'],
    reads: true,
    request: (h, w) => ({ params: { invoiceId: invoice(h, w) } }),
    hidden: (h) => [mark(h, 'Invoice.emailedTo'), mark(h, 'Invoice.cancelReason')],
  },
  {
    route: 'GET /invoices/:/pdf',
    note: 'a draft invoice has no PDF for the customer',
    allowed: ['backOffice'],
    reads: true,
    prepare: (w) => w.set('invoice', { status: 'DRAFT' }),
    request: (h, w) => ({ params: { invoiceId: invoice(h, w) } }),
  },
  {
    route: 'GET /invoices/credit-notes/:/pdf',
    note: 'the PDF of a credit note: the customer of the invoice and the back office',
    allowed: ['client', 'backOffice'],
    reads: true,
    request: (h, w) => ({ params: { creditNoteId: w.ids[h].creditNote } }),
  },
  {
    route: 'GET /invoices/credit-notes/:/pdf',
    note: 'the credit note of a draft invoice is not the customer\'s either',
    allowed: ['backOffice'],
    reads: true,
    prepare: (w) => w.set('invoice', { status: 'DRAFT' }),
    request: (h, w) => ({ params: { creditNoteId: w.ids[h].creditNote } }),
  },
  {
    route: 'GET /invoices/:',
    note: 'an invoice that is still a draft is not shown to the customer or the artisan',
    allowed: ['backOffice'],
    reads: true,
    prepare: (w) => w.set('invoice', { status: 'DRAFT' }),
    request: (h, w) => ({ params: { invoiceId: invoice(h, w) } }),
  },
];

export const invoiceSelfScenarios: SelfScenario[] = [
  { route: 'GET /invoices/mine', reads: true, request: () => ({}) },
];

export const paymentScenarios: Scenario[] = [
  {
    route: 'POST /payments/interventions/:',
    note: 'a customer asks to pay for their own job',
    allowed: ['client'],
    prepare: noOpenPayment,
    request: (h, w) => ({ params: { interventionId: job(h, w) }, body: { method: 'CASH', amount: 120 } }),
  },
  {
    route: 'GET /payments/interventions/:',
    allowed: ['client'],
    reads: true,
    request: (h, w) => ({ params: { interventionId: job(h, w) } }),
  },
  {
    route: 'POST /payments/:/check',
    note: 'asks the provider where a card payment stands: the customer who started it and the back office (a stranger and the artisan of the job are turned away); the customer gets the page of the provider only while the payment waits (its address carries the provider\'s number, as the provider writes it), and never the admin note or the key',
    allowed: ['client', 'backOffice'],
    prepare: (w) => {
      w.connectPaymentProvider();

      // Each household has its own payment at the provider (a provider's number names one payment).
      for (const [household, n] of [['A', 1], ['B', 2]] as const) {
        w.set(
          'payment',
          {
            method: 'ONLINE',
            provider: 'KONNECT',
            providerPaymentId: `ref-check-${n}`,
            payUrl: `https://pay.example.test/pay?payment_ref=ref-check-${n}`,
            adminNote: `note-check-${n}`,
            idempotencyKey: `key-check-${n}`,
            status: 'PENDING',
            expiresAt: new Date(Date.now() + 20 * 60_000),
          },
          w.ids[household].payment,
        );
        // The provider knows the payment, and says it still waits: the look goes all the way to the provider and changes nothing.
        w.paymentGateway.kept.set(`ref-check-${n}`, { state: 'PENDING', amount: null, currency: null, orderId: null });
      }
    },
    request: (h, w) => ({ params: { paymentId: w.ids[h].payment } }),
    hidden: (_household, person) => (person.role === 'CLIENT' ? ['note-check-1', 'key-check-1', 'note-check-2', 'key-check-2'] : []),
  },
  {
    route: 'GET /payments/:/receipt',
    note: 'the receipt of a paid payment: the customer who paid, the artisan of the job, the back office',
    allowed: ['client', 'artisan', 'backOffice'],
    reads: true,
    prepare: paid,
    request: (h, w) => ({ params: { paymentId: w.ids[h].payment } }),
  },
];
