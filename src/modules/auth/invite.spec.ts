import { inviteArtisan } from './invite';

process.env.FRONTEND_URL = 'https://app.example.tn';

function makeWorld(simulated = false) {
  const tokens: any[] = [];
  const revoked: any[] = [];
  const emails: any[] = [];
  const texts: any[] = [];

  const prisma: any = {
    authToken: {
      updateMany: async (args: any) => (revoked.push(args), { count: 1 }),
      create: async ({ data }: any) => (tokens.push(data), data),
    },
  };
  const notifications: any = {
    sendEmail: async (to: string, subject: string, content: string, options: any) => emails.push({ to, subject, content, options }),
    sendSms: async (to: string, content: string, options: any) => texts.push({ to, content, options }),
    isEmailSimulated: () => simulated,
  };

  return { deps: { prisma, notifications }, tokens, revoked, emails, texts };
}

const sami = { id: 12, email: 'sami@mail.tn', name: 'Sami', phone: '+21655222333' };

describe('the invitation of an artisan to choose a password (P1-11)', () => {
  it('an accepted application: a single-use link, by e-mail and by SMS, with the words of an acceptance', async () => {
    const w = makeWorld();

    const answer = await inviteArtisan(w.deps, sami, 'approved');
    const link = /https?:\/\/\S+\/reset-password\?token=[0-9a-f]{64}/.exec(w.emails[0].content)?.[0];

    expect(link).toBeTruthy();
    expect(w.emails[0].to).toBe('sami@mail.tn');
    expect(w.emails[0].subject).toBe('Votre candidature est acceptée');
    expect(w.emails[0].options).toMatchObject({
      userId: 12,
      template: { key: 'artisan.application_approved', vars: { name: 'Sami', link } },
      validForMs: 24 * 60 * 60 * 1000,
      replaces: 'auth:PASSWORD_RESET:12',
    });
    expect(w.texts[0].to).toBe('+21655222333');
    expect(w.texts[0].content).toContain('candidature est acceptée');
    expect(w.texts[0].content).toContain(link);
    expect(w.texts[0].options).toMatchObject({ userId: 12, replaces: 'auth:PASSWORD_RESET_SMS:12' });
    // a real mail server: the link is not in the answer
    expect(answer).toEqual({});
  });

  it('an artisan added by hand: the words of a new account, the template of a password setup', async () => {
    const w = makeWorld();

    await inviteArtisan(w.deps, sami, 'created');

    expect(w.emails[0].subject).toBe('Création de votre mot de passe');
    expect(w.emails[0].options.template.key).toBe('auth.password_setup');
    expect(w.texts[0].content).not.toContain('candidature');
  });

  it('only the hash of the token is stored, for 24 hours, and the previous unused link is revoked', async () => {
    const w = makeWorld();

    await inviteArtisan(w.deps, sami, 'approved');

    const raw = /token=([0-9a-f]{64})/.exec(w.emails[0].content)![1];

    expect(w.revoked[0].where).toMatchObject({ userId: 12, type: 'PASSWORD_RESET', usedAt: null, revokedAt: null });
    expect(w.tokens).toHaveLength(1);
    expect(w.tokens[0].tokenHash).not.toBe(raw);
    expect(w.tokens[0].tokenHash).toHaveLength(64);
    expect(w.tokens[0].type).toBe('PASSWORD_RESET');
    expect(w.tokens[0].expiresAt.getTime() - Date.now()).toBeGreaterThan(23 * 3600_000);
    expect(w.tokens[0].expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(24 * 3600_000);
  });

  it('with no phone number there is no SMS', async () => {
    const w = makeWorld();

    await inviteArtisan(w.deps, { ...sami, phone: null }, 'approved');

    expect(w.emails).toHaveLength(1);
    expect(w.texts).toHaveLength(0);
  });

  it('while the mails are simulated the link is given back to the staff member, and only then', async () => {
    const simulated = makeWorld(true);
    const answer = await inviteArtisan(simulated.deps, sami, 'approved');

    expect(answer.passwordSetupUrl).toMatch(/\/reset-password\?token=[0-9a-f]{64}$/);
    expect(simulated.emails[0].content).toContain(answer.passwordSetupUrl);

    const real = makeWorld(false);

    expect(await inviteArtisan(real.deps, sami, 'approved')).toEqual({});
  });

  it('two invitations: the second link is not the first', async () => {
    const w = makeWorld();

    await inviteArtisan(w.deps, sami, 'approved');
    await inviteArtisan(w.deps, sami, 'approved');

    const [first, second] = w.emails.map((email) => /token=([0-9a-f]{64})/.exec(email.content)![1]);

    expect(first).not.toBe(second);
    expect(w.revoked).toHaveLength(2);
  });
});
