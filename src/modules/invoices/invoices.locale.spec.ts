import { buildWorld } from '../../common/testing/world';
import { InvoicesService } from './invoices.service';

const FSI = '⁨';
const PDI = '⁩';

/**
 * The e-mail that carries an invoice (P3-04): the text proposed is written in the language of the customer; what the back office types
 * is sent as typed. The real InvoicesService on the in-memory database of the access suite, with a notifier that writes down what it sends.
 */
function makeWorld(locale?: string) {
  const w = buildWorld();
  const sent: Array<{ to: string; subject: string; body: string }> = [];
  const notifications: any = {
    isEmailSimulated: () => false,
    sendEmail: async (to: string, subject: string, body: string) => (sent.push({ to, subject, body }), { queued: true }),
  };
  const service = new InvoicesService(w.prisma, w.svc.events, notifications);
  const invoiceId = w.ids.A.invoice;

  const row = w.memory.rows('invoice').find((entry) => entry.id === invoiceId) as any;
  const job = w.memory.rows('intervention').find((entry) => entry.id === row.interventionId) as any;
  const client = w.memory.rows('user').find((entry) => entry.id === job.clientId) as any;

  if (locale) client.locale = locale;

  return { w, service, sent, invoiceId, row, admin: w.people.admin.user as any };
}

describe('the e-mail of an invoice, in the language of the customer (P3-04)', () => {
  it('a customer who chose Arabic: the subject and the text are Arabic, the number and the amount set apart, in dinars', async () => {
    const { service, sent, invoiceId, admin, row } = makeWorld('ar');

    await service.sendInvoiceByEmail(admin, invoiceId, { email: 'client@example.com' } as any);

    expect(sent.length).toBe(1);
    expect(sent[0].subject).toBe(`فاتورتك ${FSI}${row.invoiceNumber}${PDI}`);
    expect(sent[0].body).toContain(`${FSI}${row.invoiceNumber}${PDI}`);
    expect(sent[0].body).toContain('د.ت');
    expect(sent[0].body).not.toContain('TTC');
    expect(sent[0].body).not.toContain('Cordialement');
  });

  it('a customer who chose French, or never chose: the French e-mail it always was', async () => {
    for (const locale of ['fr', undefined]) {
      const { service, sent, invoiceId, admin, row } = makeWorld(locale);

      await service.sendInvoiceByEmail(admin, invoiceId, { email: 'client@example.com' } as any);

      expect(sent[0].subject).toBe(`Votre facture ${row.invoiceNumber}`);
      expect(sent[0].body.startsWith(`Bonjour,\n\nVotre facture ${row.invoiceNumber} d’un montant de `)).toBe(true);
      expect(sent[0].body).toContain(' TTC');
      expect(sent[0].body.endsWith('Vous pouvez la télécharger en PDF depuis votre page de suivi.\n\nCordialement.')).toBe(true);
    }
  });

  it('what the back office typed is sent as it was typed, and so is its subject in French', async () => {
    const { service, sent, invoiceId, admin, row } = makeWorld('ar');

    await service.sendInvoiceByEmail(admin, invoiceId, { email: 'client@example.com', message: 'Bonjour, voici votre facture.' } as any);

    expect(sent[0].body).toBe('Bonjour, voici votre facture.');
    expect(sent[0].subject).toBe(`Votre facture ${row.invoiceNumber}`);
  });
});
