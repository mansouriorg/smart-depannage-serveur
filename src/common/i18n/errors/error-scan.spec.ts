import { Project, SourceFile, Site, tokenize } from './error-scan';

/**
 * The scanner that proves the dictionary of Arabic sentences complete (P3-04) is itself checked on small sources, so that a
 * refusal it silently failed to read cannot make the coverage spec pass for the wrong reason.
 */

function sitesOf(text: string, others: SourceFile[] = []): Site[] {
  return new Project([{ file: 'a.ts', text }, ...others]).sites();
}

const texts = (sites: Site[]) => sites.flatMap((site) => site.sentences.map((s) => s.text));

describe('the lexer', () => {
  it('reads strings with their escapes, and a comment marker inside a string is text', () => {
    const [a, b, c] = tokenize(`'l\\'eau // pas un commentaire' "d\\u00e9j\\u00E0" 'a\\nb'`);

    expect(a.value).toBe("l'eau // pas un commentaire");
    expect(b.value).toBe('déjà');
    expect(c.value).toBe('a\nb');
  });

  it('reads a template with nested templates and braces in its values', () => {
    const [t] = tokenize('`Un ${a ? `deux ${b}` : { c: 1 }.c} trois`');

    expect(t.kind).toBe('tpl');
    expect(t.quasis).toEqual(['Un ', ' trois']);
    expect(t.exprs).toEqual(['a ? `deux ${b}` : { c: 1 }.c']);
  });

  it('skips comments and does not take a regular expression for a division or a quote for a string', () => {
    const tokens = tokenize(`// ignore 'this\n/* and "this" */ const re = /['"]x/g; const half = total / 2; const s = 'ok';`);
    const strings = tokens.filter((t) => t.kind === 'str').map((t) => t.value);

    expect(strings).toEqual(['ok']);
    expect(tokens.some((t) => t.kind === 're' && t.value === `/['"]x/g`)).toBe(true);
  });
});

describe('what the scanner finds at a throw', () => {
  it('reads a sentence given as a string, on one line or on several, with a trailing comma', () => {
    const sites = sitesOf(`
      throw new BadRequestException('Date invalide.');
      throw new NotFoundException(
        'Devis introuvable.',
      );
    `);

    expect(texts(sites)).toEqual(['Date invalide.', 'Devis introuvable.']);
    expect(sites.map((s) => s.line)).toEqual([2, 3]);
  });

  it('reads the message of an object, a list of sentences, and the reasons that go with it', () => {
    const sites = sitesOf(`
      throw new BadRequestException({ message: 'Artisan indisponible.', availability, issues: ['Occupé.'] });
      throw new ConflictException({ statusCode: 409, error: 'Conflict', message: 'Déjà fait.' });
      throw new HttpException({ statusCode: 429, message: cond ? 'Une minute.' : 'Plus tard.' }, 429);
    `);

    expect(texts(sites)).toEqual(['Artisan indisponible.', 'Occupé.', 'Déjà fait.', 'Une minute.', 'Plus tard.']);
  });

  it('puts a hole where a value goes, in a template and in a sum', () => {
    const sites = sitesOf(`
      throw new BadRequestException(\`Intervention #\${id} introuvable.\`);
      throw new BadRequestException('Trop gros: ' + max + ' Mo.');
      throw new BadRequestException(\`\${field} invalide\`);
    `);

    expect(sites.flatMap((s) => s.sentences)).toEqual([
      { kind: 'pattern', text: 'Intervention #{} introuvable.' },
      { kind: 'pattern', text: 'Trop gros: {} Mo.' },
      { kind: 'pattern', text: '{} invalide' },
    ]);
  });

  it('writes a constant or a choice between texts into the sentence', () => {
    const sites = sitesOf(`
      const UNIT = 'jours';
      throw new BadRequestException(\`Pas plus de \${n} \${UNIT}.\`);
      throw new BadRequestException(\`Il reste \${n} \${n > 1 ? 'photos' : 'photo'}.\`);
    `);

    expect(texts(sites)).toEqual(['Pas plus de {} jours.', 'Il reste {} photos.', 'Il reste {} photo.']);
  });

  it('reads a capitalised value (x.charAt(0).toUpperCase() then x.slice(1)) as the capitalised texts', () => {
    const sites = sitesOf(`
      const LABELS = { a: 'pièce d’identité', b: 'attestation' };
      const label = LABELS[kind];
      throw new BadRequestException(\`\${label.charAt(0).toUpperCase()}\${label.slice(1)} : \${error.message}\`);
    `);

    expect(texts(sites)).toEqual(['Pièce d’identité : {}', 'Attestation : {}']);
  });

  it('reads constants of the file and of other files (exported ones), and the members of an object of texts', () => {
    const other: SourceFile = {
      file: 'b.ts',
      text: `export const TAKEN = 'Déjà pris.'; export const WORDS = { used: 'Déjà utilisé.', gone: \`Parti.\` };`,
    };
    const sites = sitesOf(
      `
      const LOCAL = 'Local.';
      throw new ConflictException(TAKEN);
      throw new ConflictException(WORDS.used);
      throw new ConflictException(WORDS['gone']);
      throw new ConflictException(LOCAL);
    `,
      [other],
    );

    expect(texts(sites)).toEqual(['Déjà pris.', 'Déjà utilisé.', 'Déjà utilisé.', 'Parti.', 'Local.']);
    expect(sites.every((s) => s.unresolved.length === 0)).toBe(true);
  });

  it('reads what a function returns, with its parameters as holes', () => {
    const sites = sitesOf(`
      function words(amount: string) { if (!amount) return 'Rien.'; return \`Il manque \${amount}.\`; }
      const other = (kind) => kind === 'a' ? 'Un.' : 'Deux.';
      throw new ConflictException(words(x));
      throw new ConflictException(other(y));
    `);

    expect(texts(sites)).toEqual(['Rien.', 'Il manque {}.', 'Un.', 'Deux.']);
  });

  it('reports what it cannot read, with the source text', () => {
    const sites = sitesOf(`
      throw new BadRequestException(verdict.message);
      throw new BadRequestException(error instanceof Error ? error.message : 'Paramètres invalides.');
      throw new BadRequestException(unknownHelper(1, 2));
    `);

    expect(sites.map((s) => s.unresolved)).toEqual([['verdict.message'], ['error.message'], ['unknownHelper(1, 2)']]);
    expect(sites[1].sentences.map((s) => s.text)).toEqual(['Paramètres invalides.']);
  });

  it('does not read a sentence in a comment or in a string that only looks like a throw', () => {
    const sites = sitesOf(`
      // throw new BadRequestException('Dans un commentaire.');
      const doc = "throw new BadRequestException('Dans un texte.')";
      throw new NotFoundException();
    `);

    expect(sites).toEqual([]);
  });

  it('counts every construction of an exception, the ones it does not read included', () => {
    const project = new Project([
      { file: 'a.ts', text: `throw new BadRequestException('A.'); throw new BadRequestException(x); throw new NotFoundException(); throw new WsException('B.');` },
    ]);

    expect(Object.fromEntries(project.constructed())).toEqual({ BadRequestException: 2, NotFoundException: 1, WsException: 1 });
  });
});

describe('the reasons that go with a refusal, and the messages of the validation decorators', () => {
  it('reads what is pushed into issues, and into a list the file throws whole', () => {
    const sites = sitesOf(`
      const issues: string[] = [];
      issues.push('Occupé.');
      if (x) issues.push(REASON, 'Complet.');
      const problems: string[] = [];
      const other: string[] = [];
      problems.push('Nom manquant.');
      other.push('Pas une raison.');
      throw new BadRequestException(problems);
    `);

    expect(texts(sites)).toEqual(['Occupé.', 'Complet.', 'Nom manquant.']);
    expect(sites.filter((s) => s.unresolved.length).map((s) => s.unresolved)).toEqual([['REASON']]);
  });

  it('does not take the shorthand issues of an exception for a sentence', () => {
    const sites = sitesOf(`throw new BadRequestException({ message: 'Non.', issues });`);

    expect(texts(sites)).toEqual(['Non.']);
    expect(sites.every((s) => s.unresolved.length === 0)).toBe(true);
  });

  it('reads the message of a validation decorator', () => {
    const sites = sitesOf(`
      class Dto {
        @Matches(/^\\d{6}$/, { message: 'Le code comporte 6 chiffres.' })
        code: string;
        @IsString()
        name: string;
      }
    `);

    expect(sites).toHaveLength(1);
    expect(sites[0].by).toBe('@Matches');
    expect(texts(sites)).toEqual(['Le code comporte 6 chiffres.']);
  });
});

describe('where a helper gets its words', () => {
  const project = new Project([
    {
      file: 'helper.ts',
      text: `
        export function ask(value: unknown, message: string) { if (!value) throw new BadRequestException(message); }
        const WORDS = { one: 'Un.', two: \`Deux \${x}.\` };
        const parts: string[] = [];
        parts.push('Première.', \`Seconde \${n}.\`);
        const verdict = { ok: false, reason: 'unknown', message: 'Inconnu.' };
        function other() { return { message: \`Interdit \${a}.\`, other: 'Pas ça.' }; }
        function say(a) { return \`Dit \${a}.\`; }
      `,
    },
    { file: 'caller.ts', text: `ask(a, 'Premier appel.'); ask(b, WORDS.one); const c = { conflictMessage: 'Changé.' };` },
  ]);

  it('lists the arguments of the calls of a function, and not its declaration', () => {
    const calls = project.callArguments('ask', 1);

    expect(calls.map((c) => c.file)).toEqual(['caller.ts', 'caller.ts']);
    expect(calls.map((c) => c.sentences.map((s) => s.text))).toEqual([['Premier appel.'], []]);
    expect(calls[1].unresolved).toEqual(['WORDS.one']);
  });

  it('lists the values of a property in one file or in all', () => {
    expect(project.property('helper.ts', 'message').flatMap((s) => s.sentences.map((x) => x.text))).toEqual(['Inconnu.', 'Interdit {}.']);
    expect(project.propertyEverywhere('conflictMessage').flatMap((s) => s.sentences.map((x) => x.text))).toEqual(['Changé.']);
  });

  it('lists what is pushed into a list, the texts of a constant object and the returns of a function', () => {
    expect(project.pushes('helper.ts', 'parts').flatMap((s) => s.sentences.map((x) => x.text))).toEqual(['Première.', 'Seconde {}.']);
    expect(project.texts('helper.ts', 'WORDS').sentences.map((s) => s.text)).toEqual(['Un.', 'Deux {}.']);
    expect(project.returns('helper.ts', 'say').sentences.map((s) => s.text)).toEqual(['Dit {}.']);
  });

  it('refuses a file or a name it does not know, so that a renamed helper fails the spec', () => {
    expect(() => project.property('nowhere.ts', 'message')).toThrow();
    expect(() => project.texts('helper.ts', 'NOPE')).toThrow();
    expect(() => project.returns('helper.ts', 'nope')).toThrow();
  });
});
