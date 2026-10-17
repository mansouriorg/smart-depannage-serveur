import { MessageTemplatesService } from './message-templates.service';

function make(rows: Record<string, any> = {}, failing = false) {
  let reads = 0;

  const prisma: any = {
    notificationTemplate: {
      findUnique: async ({ where }: any) => {
        reads++;
        if (failing) throw new Error('database is down');
        return rows[where.key] ?? null;
      },
    },
  };

  const service = new MessageTemplatesService(prisma);
  const warnings: string[] = [];
  (service as any).logger = { warn: (line: string) => warnings.push(line) };

  return { service, reads: () => reads, warnings };
}

const email = { key: 'auth.password_reset', type: 'EMAIL', isActive: true, subject: 'Salut {{name}}', content: 'Lien {{link}}' };
const fallback = { subject: 'Sujet', content: 'Texte' };

describe('MessageTemplatesService', () => {
  it('no template: the built-in text', async () => {
    const { service } = make();

    expect(await service.render('auth.password_reset', 'EMAIL', {}, fallback)).toEqual({
      subject: 'Sujet',
      content: 'Texte',
      fromTemplate: false,
    });
  });

  it('an active template of the right type is filled in, subject included', async () => {
    const { service } = make({ 'auth.password_reset': email });

    expect(await service.render('auth.password_reset', 'EMAIL', { name: 'Sami', link: 'https://x.tn' }, fallback)).toEqual({
      subject: 'Salut Sami',
      content: 'Lien https://x.tn',
      fromTemplate: true,
    });
  });

  it('a template without a subject keeps the built-in subject', async () => {
    const { service } = make({ 'auth.password_reset': { ...email, subject: null } });

    expect((await service.render('auth.password_reset', 'EMAIL', {}, fallback)).subject).toBe('Sujet');
  });

  it('inactive, wrong type, or empty: ignored', async () => {
    for (const row of [
      { ...email, isActive: false },
      { ...email, type: 'SMS' },
      { ...email, content: '   ' },
    ]) {
      const { service } = make({ 'auth.password_reset': row });
      expect((await service.render('auth.password_reset', 'EMAIL', {}, fallback)).fromTemplate).toBe(false);
    }
  });

  it('a template that edits the code or link away is not used, and one warning says so', async () => {
    const { service, warnings } = make({
      'auth.password_reset': { ...email, content: 'Cliquez ici pour réinitialiser.' },
      'auth.phone_code': { key: 'auth.phone_code', type: 'SMS', isActive: true, content: 'Votre code est {{ code }}' },
      // step 4: the activation SMS carries the code only; a text that offers just the link is not used
      'guest.activation_sms': { key: 'guest.activation_sms', type: 'SMS', isActive: true, content: 'Lien: {{link}}' },
      'auth.email_change': { key: 'auth.email_change', type: 'EMAIL', isActive: true, content: 'Confirmez: {{link}}' },
      'guest.activation_email': { key: 'guest.activation_email', type: 'EMAIL', isActive: true, content: 'Bonjour {{name}}' },
    });

    const reset = await service.render('auth.password_reset', 'EMAIL', { link: 'https://x.tn' }, fallback);
    await service.render('auth.password_reset', 'EMAIL', { link: 'https://x.tn' }, fallback);
    expect(reset).toEqual({ subject: 'Sujet', content: 'Texte', fromTemplate: false });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('{{link}}');

    // spaces inside the braces are fine; either placeholder satisfies a message that has both
    expect((await service.render('auth.phone_code', 'SMS', { code: '123456' }, { content: 'x' })).content).toBe('Votre code est 123456');
    expect((await service.render('guest.activation_sms', 'SMS', { link: 'https://y.tn', code: '123456' }, { content: 'x' })).fromTemplate).toBe(false);
    expect((await service.render('auth.email_change', 'EMAIL', { link: 'https://z.tn' }, fallback)).content).toBe('Confirmez: https://z.tn');
    expect((await service.render('guest.activation_email', 'EMAIL', {}, fallback)).fromTemplate).toBe(false);
  });

  it('other templates may leave placeholders out', async () => {
    const { service } = make({ 'QUOTE_SENT.EMAIL': { key: 'QUOTE_SENT.EMAIL', type: 'EMAIL', isActive: true, content: 'Nouveau devis.' } });

    expect((await service.render('QUOTE_SENT.EMAIL', 'EMAIL', { title: 'x' }, fallback)).content).toBe('Nouveau devis.');
  });

  it('a database error never stops the message: the built-in text is used', async () => {
    const { service } = make({}, true);

    expect((await service.render('auth.password_reset', 'EMAIL', {}, fallback)).content).toBe('Texte');
  });

  it('reads a template once a minute, not once a message; clearCache forces a read', async () => {
    const { service, reads } = make({ 'auth.password_reset': email });

    await service.render('auth.password_reset', 'EMAIL', {}, fallback);
    await service.render('auth.password_reset', 'EMAIL', {}, fallback);
    expect(reads()).toBe(1);

    service.clearCache();
    await service.render('auth.password_reset', 'EMAIL', {}, fallback);
    expect(reads()).toBe(2);
  });
});
