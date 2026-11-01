import { MessageTemplatesService } from './message-templates.service';

/** Which keys the service asked the table for, and what it answered. */
function make(rows: Record<string, any> = {}) {
  const asked: string[] = [];

  const prisma: any = {
    notificationTemplate: {
      findUnique: async ({ where }: any) => {
        asked.push(where.key);
        return rows[where.key] ?? null;
      },
    },
  };

  const service = new MessageTemplatesService(prisma);
  const warnings: string[] = [];
  (service as any).logger = { warn: (line: string) => warnings.push(line) };

  return { service, asked, warnings };
}

const french = { key: 'QUOTE_SENT.SMS', type: 'SMS', isActive: true, subject: null, content: 'Devis de {{amount}} reçu' };
const arabic = { key: 'QUOTE_SENT.SMS@ar', type: 'SMS', isActive: true, subject: null, content: 'وصلك عرض سعر بمبلغ {{amount}}' };
const builtIn = { content: 'Texte intégré' };
const builtInAr = { content: 'النص المدمج' };

describe('templates written in the dashboard, and the language (P3-04)', () => {
  it('French keeps the key it always had and no other row is read', async () => {
    const { service, asked } = make({ 'QUOTE_SENT.SMS': french, 'QUOTE_SENT.SMS@ar': arabic });

    const rendered = await service.render('QUOTE_SENT.SMS', 'SMS', { amount: '120' }, builtIn);

    expect(rendered).toEqual({ subject: undefined, content: 'Devis de 120 reçu', fromTemplate: true });
    expect(asked).toEqual(['QUOTE_SENT.SMS']);
  });

  it('asking for French on purpose is the same as asking for nothing', async () => {
    const { service, asked } = make({ 'QUOTE_SENT.SMS': french });

    await service.render('QUOTE_SENT.SMS', 'SMS', { amount: '120' }, builtIn, 'fr');

    expect(asked).toEqual(['QUOTE_SENT.SMS']);
  });

  it('Arabic reads the row "<key>@ar" and nothing else', async () => {
    const { service, asked } = make({ 'QUOTE_SENT.SMS': french, 'QUOTE_SENT.SMS@ar': arabic });

    const rendered = await service.render('QUOTE_SENT.SMS', 'SMS', { amount: '120' }, builtInAr, 'ar');

    expect(rendered.content).toBe('وصلك عرض سعر بمبلغ 120');
    expect(rendered.fromTemplate).toBe(true);
    expect(asked).toEqual(['QUOTE_SENT.SMS@ar']);
  });

  it('Arabic with only a French template: the built-in Arabic text, never the French template', async () => {
    const { service } = make({ 'QUOTE_SENT.SMS': french });

    const rendered = await service.render('QUOTE_SENT.SMS', 'SMS', { amount: '120' }, builtInAr, 'ar');

    expect(rendered).toEqual({ subject: undefined, content: 'النص المدمج', fromTemplate: false });
  });

  it('Arabic with no template at all: the built-in Arabic text', async () => {
    const { service } = make();

    expect((await service.render('QUOTE_SENT.SMS', 'SMS', {}, builtInAr, 'ar')).content).toBe('النص المدمج');
  });

  it('an Arabic row that is switched off, of another type, or empty is not used', async () => {
    for (const row of [
      { ...arabic, isActive: false },
      { ...arabic, type: 'EMAIL' },
      { ...arabic, content: '   ' },
    ]) {
      const { service } = make({ 'QUOTE_SENT.SMS': french, 'QUOTE_SENT.SMS@ar': row });

      const rendered = await service.render('QUOTE_SENT.SMS', 'SMS', { amount: '120' }, builtInAr, 'ar');

      expect(rendered).toEqual({ subject: undefined, content: 'النص المدمج', fromTemplate: false });
    }
  });

  it('an Arabic row serves Arabic only: French never reads it', async () => {
    const { service } = make({ 'QUOTE_SENT.SMS@ar': arabic });

    expect(await service.render('QUOTE_SENT.SMS', 'SMS', { amount: '120' }, builtIn, 'fr')).toEqual({
      subject: undefined,
      content: 'Texte intégré',
      fromTemplate: false,
    });
  });

  it('the subject of an Arabic e-mail template is its own, and a row without one keeps the built-in Arabic subject', async () => {
    const withSubject = { key: 'auth.password_reset@ar', type: 'EMAIL', isActive: true, subject: 'مرحبًا {{name}}', content: 'الرابط {{link}}' };
    const withoutSubject = { ...withSubject, subject: null };
    const fallbackAr = { subject: 'العنوان المدمج', content: 'النص المدمج' };

    const one = make({ 'auth.password_reset@ar': withSubject });
    const two = make({ 'auth.password_reset@ar': withoutSubject });

    expect(await one.service.render('auth.password_reset', 'EMAIL', { name: 'سامي', link: 'L' }, fallbackAr, 'ar')).toEqual({
      subject: 'مرحبًا سامي',
      content: 'الرابط L',
      fromTemplate: true,
    });
    expect((await two.service.render('auth.password_reset', 'EMAIL', { link: 'L' }, fallbackAr, 'ar')).subject).toBe('العنوان المدمج');
  });

  describe('a message whose point is a code or a link (MUST_CONTAIN_ONE_OF, kept under the base key for both languages)', () => {
    const lostCode = { key: 'auth.phone_code@ar', type: 'SMS', isActive: true, subject: null, content: 'رمز التحقق غير موجود هنا' };
    const goodCode = { ...lostCode, content: 'رمزك {{code}}' };

    it('an Arabic template that lost its code is refused: the built-in Arabic text, with one warning naming the Arabic row', async () => {
      const { service, warnings } = make({ 'auth.phone_code@ar': lostCode });

      for (let time = 0; time < 3; time += 1) {
        const rendered = await service.render('auth.phone_code', 'SMS', { code: '123456' }, builtInAr, 'ar');

        expect(rendered).toEqual({ subject: undefined, content: 'النص المدمج', fromTemplate: false });
      }

      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain('auth.phone_code@ar');
      expect(warnings[0]).toContain('{{code}}');
    });

    it('an Arabic template that keeps its code is used', async () => {
      const { service } = make({ 'auth.phone_code@ar': goodCode });

      expect((await service.render('auth.phone_code', 'SMS', { code: '123456' }, builtInAr, 'ar')).content).toBe('رمزك 123456');
    });

    it('the French rule still holds, and a bad Arabic row does not make a good French one fail', async () => {
      const goodFrench = { key: 'auth.phone_code', type: 'SMS', isActive: true, subject: null, content: 'Votre code {{code}}' };
      const { service } = make({ 'auth.phone_code': goodFrench, 'auth.phone_code@ar': lostCode });

      expect((await service.render('auth.phone_code', 'SMS', { code: '123456' }, builtIn)).content).toBe('Votre code 123456');
      expect((await service.render('auth.phone_code', 'SMS', { code: '123456' }, builtInAr, 'ar')).fromTemplate).toBe(false);
    });
  });

  it('a table that cannot be read means the built-in text, in either language', async () => {
    const prisma: any = { notificationTemplate: { findUnique: async () => { throw new Error('database is down'); } } };
    const service = new MessageTemplatesService(prisma);
    (service as any).logger = { warn: () => undefined };

    expect((await service.render('QUOTE_SENT.SMS', 'SMS', {}, builtIn)).content).toBe('Texte intégré');
    expect((await service.render('QUOTE_SENT.SMS', 'SMS', {}, builtInAr, 'ar')).content).toBe('النص المدمج');
  });

  it('the rule is written down in the class comment', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const source = require('fs').readFileSync(require('path').join(__dirname, 'message-templates.service.ts'), 'utf8') as string;

    expect(source).toContain('`<key>@ar`');
    expect(source).toContain('The French template is never used for Arabic');
  });
});
