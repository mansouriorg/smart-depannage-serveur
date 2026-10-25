import { resetLocale } from '../../common/locale/locale';
import { World, emptyWorld } from '../../common/testing/world';

/**
 * The company screen of the back office (P2-09), on the real services: what it writes in the settings is what the invoices print.
 * The bodies below are the ones the screen sends (the form reads them in the shared package, `readCompanyForm`), and the invoice is
 * issued by the invoices service, so a field the screen names differently from the one the invoice reads is found here.
 */

interface Desk {
  world: World;
  admin: any;
  client: any;
  artisan: any;
  job: () => any;
}

function desk(settings: Record<string, unknown> | null = {}): Desk {
  resetLocale();

  const world = emptyWorld();
  const make = (role: string, name: string, extra: Record<string, unknown> = {}) => world.memory.plant('user', { role, name, ...extra });
  const admin = make('ADMIN', 'Admin Chef');
  const client = make('CLIENT', 'Salma Ben Ali', { email: 'salma@example.tn', phone: '+21622123456' });
  const artisan = make('ARTISAN', 'Karim Plombier');

  world.memory.plant('artisanProfile', { userId: artisan.id, verificationStatus: 'APPROVED' });

  // A company that has never been set up: only the row the server creates on first read.
  if (settings !== null) world.memory.plant('companySettings', { companyName: 'Smart Dépannage', paymentMethods: ['ONLINE', 'CASH', 'BANK_TRANSFER'], ...settings });

  const job = () => {
    const made = world.memory.plant('intervention', { clientId: client.id, artisanId: artisan.id, status: 'COMPLETED', serviceType: 'PLOMBIER', address: '5 Rue de Marseille, La Marsa', description: 'Fuite', contactName: null });

    world.memory.plant('quote', { interventionId: made.id, createdById: artisan.id, status: 'ACCEPTED', amountHT: 100, taxRate: 19, taxAmount: 19, amountTTC: 119, currency: 'TND' });

    return made;
  };

  return { world, admin, client, artisan, job };
}

const save = (d: Desk, body: Record<string, unknown>) => d.world.svc.admin.updateCompanySettings(body as any);
const issue = (d: Desk, jobId: number): Promise<any> => d.world.svc.invoices.createForIntervention(jobId, d.admin.id, {} as any);
const invoicesOf = (d: Desk) => d.world.memory.rows('invoice');

/** What the server answers when it refuses a save: the status and the sentence (null when it accepted). */
async function refusal(work: Promise<unknown>): Promise<{ status: number; message: string } | null> {
  try {
    await work;
  } catch (error) {
    const known = error as { getStatus?: () => number; message?: string };

    return { status: typeof known.getStatus === 'function' ? known.getStatus() : 500, message: String(known.message) };
  }

  return null;
}

/** The body of the screen's first save on a company that was never set up. */
const FIRST_SAVE = {
  companyName: 'Dépannage Express SARL',
  companyPhone: '71 123 456',
  companyEmail: 'facturation@depannage-express.tn',
  companyAddress: '8 Rue de Rome, 1000 Tunis',
  matriculeFiscal: '1234567A/M/000',
  registreCommerce: 'B01234562026',
  rib: '08006012345678901234',
  stampDuty: 1,
  paymentTerms: 'Paiement à réception.',
  invoiceLegalMentions: 'SARL au capital de 10 000 TND.',
};

describe('the company screen writes what the invoices print (P2-09)', () => {
  it('prints on an invoice the name and the address set in the screen', async () => {
    const d = desk(null);

    await save(d, FIRST_SAVE);
    await issue(d, d.job().id);

    const stored = invoicesOf(d)[0];

    expect([stored.companyName, stored.companyAddress, stored.companyPhone, stored.companyEmail]).toEqual(['Dépannage Express SARL', '8 Rue de Rome, 1000 Tunis', '71 123 456', 'facturation@depannage-express.tn']);
    expect([stored.companyTaxId, stored.companyRegistre, stored.companyRib]).toEqual(['1234567A/M/000', 'B01234562026', '08006012345678901234']);
    expect([stored.legalMentions, stored.paymentTerms]).toEqual(['SARL au capital de 10 000 TND.', 'Paiement à réception.']);
  });

  it('keeps on an invoice already issued the name it had, and gives the next one the new name', async () => {
    const d = desk(null);

    await save(d, FIRST_SAVE);

    const first = await issue(d, d.job().id);

    await save(d, { companyName: 'Smart Dépannage Tunisie', companyAddress: '1 Avenue de Carthage, Tunis' });

    const second = await issue(d, d.job().id);
    const byId = (id: number) => invoicesOf(d).find((row) => row.id === id);

    expect([byId(first.id).companyName, byId(first.id).companyAddress]).toEqual(['Dépannage Express SARL', '8 Rue de Rome, 1000 Tunis']);
    expect([byId(second.id).companyName, byId(second.id).companyAddress]).toEqual(['Smart Dépannage Tunisie', '1 Avenue de Carthage, Tunis']);
  });

  it('leaves alone what a save does not name, and clears what it names empty', async () => {
    const d = desk(null);

    await save(d, FIRST_SAVE);
    await save(d, { companyName: 'Dépannage Express', registreCommerce: '', paymentTerms: '   ' });

    const row = d.world.memory.rows('companySettings')[0];

    expect([row.companyName, row.companyAddress, row.matriculeFiscal, row.rib]).toEqual(['Dépannage Express', '8 Rue de Rome, 1000 Tunis', '1234567A/M/000', '08006012345678901234']);
    expect([row.registreCommerce, row.paymentTerms]).toEqual([null, null]);
  });

  it('shows to the screen the values an invoice would print, in the same fields', async () => {
    const d = desk(null);

    await save(d, FIRST_SAVE);

    const read = (await d.world.svc.admin.getCompanySettings()) as Record<string, any>;

    expect([read.companyName, read.companyAddress, read.matriculeFiscal, read.registreCommerce, read.rib, read.paymentTerms, read.invoiceLegalMentions]).toEqual([
      'Dépannage Express SARL',
      '8 Rue de Rome, 1000 Tunis',
      '1234567A/M/000',
      'B01234562026',
      '08006012345678901234',
      'Paiement à réception.',
      'SARL au capital de 10 000 TND.',
    ]);
    expect(Number(String(read.stampDuty))).toBe(1);
  });

  it('says on the invoice that the mentions were not confirmed, until the screen confirms them with a name', async () => {
    const d = desk(null);

    await save(d, FIRST_SAVE);
    await issue(d, d.job().id);
    await save(d, { invoiceRulesConfirmed: true, invoiceRulesConfirmedBy: 'Admin Chef' });
    await issue(d, d.job().id);

    expect(invoicesOf(d).map((row) => row.mentionsConfirmed)).toEqual([false, true]);
  });

  it('takes the confirmation away when the screen changes the name, because the name is printed', async () => {
    const d = desk(null);

    await save(d, FIRST_SAVE);
    await save(d, { invoiceRulesConfirmed: true, invoiceRulesConfirmedBy: 'Admin Chef' });
    await save(d, { companyName: 'Un autre nom' });

    const row = d.world.memory.rows('companySettings')[0];

    expect(row.invoiceRulesConfirmedAt ?? null).toBeNull();
    expect(row.invoiceRulesConfirmedBy ?? null).toBeNull();
  });

  it('takes the confirmation away for each setting an invoice prints, and keeps it for one it does not print', async () => {
    const printed: Array<[string, unknown]> = [
      ['companyName', 'Un autre nom'],
      ['companyPhone', '70 000 000'],
      ['companyEmail', 'autre@depannage-express.tn'],
      ['companyAddress', '1 Avenue de Carthage, Tunis'],
      ['matriculeFiscal', '7654321B/M/000'],
      ['registreCommerce', 'B99999992026'],
      ['rib', '08006012345678901235'],
      ['invoiceLegalMentions', 'Autres mentions.'],
      ['paymentTerms', 'Paiement à 30 jours.'],
      ['stampDuty', 2],
      ['taxRates', [{ code: 'STANDARD', label: 'TVA 19 %', rate: 19 }, { code: 'REDUCED_13', label: 'TVA 13 %', rate: 13 }]],
      ['defaultTaxRate', 13],
    ];

    for (const [field, value] of printed) {
      const d = desk(null);

      await save(d, FIRST_SAVE);
      await save(d, { invoiceRulesConfirmed: true, invoiceRulesConfirmedBy: 'Admin Chef' });
      expect(d.world.memory.rows('companySettings')[0].invoiceRulesConfirmedAt).toBeInstanceOf(Date);

      await save(d, { [field]: value });

      expect([field, d.world.memory.rows('companySettings')[0].invoiceRulesConfirmedAt ?? null]).toEqual([field, null]);
    }

    const d = desk(null);

    await save(d, FIRST_SAVE);
    await save(d, { invoiceRulesConfirmed: true, invoiceRulesConfirmedBy: 'Admin Chef' });
    await save(d, { paymentMethods: ['CASH'] });

    expect(d.world.memory.rows('companySettings')[0].invoiceRulesConfirmedAt).toBeInstanceOf(Date);
  });

  it('keeps the confirmation when the screen saves the same values again', async () => {
    const d = desk(null);

    await save(d, FIRST_SAVE);
    await save(d, { invoiceRulesConfirmed: true, invoiceRulesConfirmedBy: 'Admin Chef' });
    await save(d, { companyName: FIRST_SAVE.companyName, companyAddress: FIRST_SAVE.companyAddress });

    expect(d.world.memory.rows('companySettings')[0].invoiceRulesConfirmedAt).toBeInstanceOf(Date);
  });

  it('refuses a company without a name, which no invoice can do without, and changes nothing', async () => {
    const d = desk(null);

    await save(d, FIRST_SAVE);

    for (const blank of ['', '   ', '\t\n', null]) {
      expect(await refusal(save(d, { companyName: blank, companyAddress: 'Ailleurs' }))).toEqual({ status: 400, message: 'Le nom de l’entreprise ne peut pas être vide.' });
    }

    const row = d.world.memory.rows('companySettings')[0];

    expect([row.companyName, row.companyAddress]).toEqual(['Dépannage Express SARL', '8 Rue de Rome, 1000 Tunis']);
  });

  it('writes the name without the spaces around it, and leaves it alone when the save does not name it', async () => {
    const d = desk(null);

    await save(d, { ...FIRST_SAVE, companyName: '  Dépannage Express  ' });
    expect(d.world.memory.rows('companySettings')[0].companyName).toBe('Dépannage Express');

    await save(d, { companyAddress: 'Nouvelle adresse' });
    expect(d.world.memory.rows('companySettings')[0].companyName).toBe('Dépannage Express');
  });

  it('says in one sentence what is missing before the mentions can be confirmed', async () => {
    const d = desk({ companyName: null });

    expect(await refusal(save(d, { invoiceRulesConfirmed: true, invoiceRulesConfirmedBy: 'Admin Chef' }))).toEqual({ status: 400, message: 'Les mentions ne peuvent pas être confirmées : renseignez d’abord le nom de l’entreprise, l’adresse et le matricule fiscal.' });
    expect(await refusal(save(d, { companyName: 'Express', invoiceRulesConfirmed: true, invoiceRulesConfirmedBy: 'Admin Chef' }))).toEqual({ status: 400, message: 'Les mentions ne peuvent pas être confirmées : renseignez d’abord l’adresse et le matricule fiscal.' });
    expect(await refusal(save(d, { companyName: 'Express', companyAddress: 'Tunis', invoiceRulesConfirmed: true, invoiceRulesConfirmedBy: 'Admin Chef' }))).toEqual({ status: 400, message: 'Les mentions ne peuvent pas être confirmées : renseignez d’abord le matricule fiscal.' });
  });
});
