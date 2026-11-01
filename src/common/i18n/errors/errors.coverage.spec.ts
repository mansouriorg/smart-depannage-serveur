import { listSourceFiles, readSource, stripComments } from '../../testing/source-scan';
import { EXCEPTIONS, HOLE, Project, Site } from './error-scan';
import { ERRORS_AR } from './errors.ar';

/**
 * Every sentence the server can answer to a refused request has an Arabic one (P3-04).
 *
 * The scanner (`error-scan.ts`) reads the sources and lists the sentences of `new BadRequestException(...)` and the other
 * exceptions of Nest, of `issues.push(...)`, of the lists of reasons a file throws whole, and of the messages of the validation
 * decorators. This spec checks that:
 *
 *  - every sentence it found is a key of the dictionary (a sentence written with a template literal is a pattern: a `{}` for each
 *    value), and no key of the dictionary is left over from a sentence the code no longer writes;
 *  - every exception of the sources was read, or is listed here with the reason;
 *  - a sentence that is not written where it is thrown (a helper's, a parameter's, a property's) is listed in `UNREAD` with its
 *    exact count and the places the sentences come from, which are scanned too. A new one of those fails this spec until it is
 *    listed.
 */

const SOURCES = listSourceFiles().map((file) => ({ file, text: readSource(file) }));
const project = new Project(SOURCES);

/** Where the sentences of an expression that is not text come from. */
type Producer =
  | { property: string; file?: string } // the value of `property:` in the object literals of a file, or of every file
  | { call: string; argument: number; file?: string } // the argument at that position in the calls of a function (in one file, or in all)
  | { parameterDefault: string; file: string } // `function f(a, name = '...')`
  | { literals: string[]; file: string } // words listed by hand, each checked to be a string literal of the file
  | { texts: string; file: string } // the texts of a constant object or array
  | { pushes: string; file: string }; // `list.push('...')`

interface Unread {
  /** The file of the place where the expression stands. */
  file: string;
  /** The expression, as the scanner prints it. */
  expression: string;
  /** How many times it stands in the sources and in the producers; a new one fails the spec. */
  count: number;
  via: Producer[];
  reason: string;
}

const UNREAD: Unread[] = [
  {
    file: 'common/money/document-totals.ts',
    expression: 'message',
    count: 3,
    via: [
      { call: 'requestAmount', argument: 1 },
      { call: 'requestTaxRate', argument: 1 },
    ],
    reason: 'requestAmount and requestTaxRate refuse with the sentence their caller gives as second argument',
  },
  {
    file: 'common/money/document-totals.ts',
    expression: 'options.invalidAmount',
    count: 2,
    via: [{ property: 'invalidAmount' }],
    reason: 'an option of totalsFromAmount that a caller may set; no caller does, so the default sentence is the only one',
  },
  {
    file: 'common/money/document-totals.ts',
    expression: 'options.invalidRate',
    count: 1,
    via: [{ property: 'invalidRate' }],
    reason: 'an option of totalsFromAmount that a caller may set; no caller does, so the default sentence is the only one',
  },
  {
    file: 'common/money/document-totals.ts',
    expression: 'invalidRate',
    count: 1,
    via: [
      { call: 'totalsFromItems', argument: 3 },
      { parameterDefault: 'invalidRate', file: 'common/money/document-totals.ts' },
    ],
    reason: 'the fourth parameter of totalsFromItems: the sentence a caller gives, or its default',
  },
  {
    file: 'modules/admin/admin.service.ts',
    expression: 'error.message',
    count: 1,
    via: [],
    reason: 'the staff settings route (the dashboard, which stays French) repeats the message of the Error that localeOfRow throws: developer English from common/locale',
  },
  {
    file: 'modules/assignment/artisan-availability.ts',
    expression: 'schedule.reason',
    count: 1,
    via: [{ property: 'reason', file: 'common/availability/weekly-schedule.ts' }],
    reason: 'the reason of a weekly schedule check, written in weekly-schedule.ts',
  },
  {
    file: 'modules/intervention-workflow/transition-status.ts',
    expression: 'verdict.message',
    count: 3,
    via: [{ property: 'message', file: 'modules/intervention-workflow/intervention-status.ts' }],
    reason: 'the verdict of the status table (checkTransition) carries the sentence, written in intervention-status.ts',
  },
  {
    file: 'modules/proofs/proofs.service.ts',
    expression: 'verdict.message',
    count: 1,
    via: [{ property: 'message', file: 'modules/intervention-workflow/intervention-status.ts' }],
    reason: 'the verdict of the status table (checkTransition) carries the sentence, written in intervention-status.ts',
  },
  {
    file: 'modules/intervention-workflow/transition-status.ts',
    expression: 'params.conflictMessage',
    count: 2,
    via: [{ property: 'conflictMessage' }],
    reason: 'an option of transitionStatus: the sentence of the caller that wants its own, written as conflictMessage in the callers',
  },
  {
    file: 'modules/mission-actions/mission-actions.service.ts',
    expression: 'issues.map((issue) => ISSUES_FOR_THE_ARTISAN[issue] ?? issue)',
    count: 1,
    via: [{ texts: 'ISSUES_FOR_THE_ARTISAN', file: 'modules/mission-actions/mission-actions.service.ts' }],
    reason: 'the reasons of the dispatcher are put in the words of the artisan from this table; any other stays as it is (and is in the list above)',
  },
  {
    file: 'modules/proofs/proofs.service.ts',
    expression: "parts.join(' ')",
    count: 1,
    via: [{ pushes: 'parts', file: 'modules/proofs/proof-policy.ts' }],
    reason: 'refusalMessage joins one sentence per reason of the refusal with a space; the translator translates them one by one',
  },
  {
    file: 'modules/quotes/quote-decisions.ts',
    expression: 'refusal',
    count: 1,
    via: [{ call: 'ensureAnswerable', argument: 1 }],
    reason: 'ensureAnswerable refuses with the sentence its caller gives as second argument (by.refusal, below)',
  },
  {
    file: 'modules/quotes/quote-decisions.ts',
    expression: 'by.refusal',
    count: 4,
    via: [{ property: 'refusal' }],
    reason: 'the answer of the customer carries the sentence to refuse with (refusal), written where the answer is built',
  },
];

/**
 * Words that go into a sentence as a value, in French (`${label} est obligatoire.`): the dictionary translates them as terms, so the
 * Arabic sentence has Arabic words in it, not a French noun. Where each comes from is scanned like a sentence.
 */
const TERMS: { via: Producer; reason: string }[] = [
  {
    via: { call: 'text', argument: 1, file: 'modules/artisans/apply-form.ts' },
    reason: 'the name of a field of the application form, in "{} est obligatoire."',
  },
  {
    via: { call: 'positive', argument: 1, file: 'modules/cash-ledger/cash-ledger.service.ts' },
    reason: 'the name of an amount, in "{} invalide: un montant positif..."',
  },
  {
    via: { call: 'signed', argument: 1, file: 'modules/cash-ledger/cash-ledger.service.ts' },
    reason: 'the name of an amount, in "{} invalide: un montant avec au plus trois décimales."',
  },
  {
    via: { call: 'tooMany', argument: 1 },
    reason: 'what a summary counts, in "Trop de {} pour un résumé..."',
  },
  {
    via: { literals: ['terminée', 'annulée', 'en litige'], file: 'modules/scheduling/scheduling.service.ts' },
    reason: 'the state of the mission, in "Cette mission est {}: son rendez-vous ne peut plus être modifié." (the loop variable of a for...of over inline pairs)',
  },
  {
    via: { literals: ['le nom de l’entreprise', 'l’adresse', 'le matricule fiscal'], file: 'modules/admin/admin.service.ts' },
    reason: 'what an invoice must carry before its mentions are confirmed, in "Les mentions ne peuvent pas être confirmées : renseignez d’abord {}." (one, or several joined by a comma and "et")',
  },
  {
    via: { property: 'label', file: 'common/trades/trades.ts' },
    reason: 'the name of a trade, alone and in the lists "Indiquez au moins un métier parmi: {}." and "Choisissez parmi: {}.", and in the refusal of a service of another trade',
  },
];

/** The exceptions this spec does not read, with the reason (the number is pinned). */
const NOT_HTTP: Record<string, { count: number; reason: string }> = {
  WsException: { count: 10, reason: 'the socket gateway answers over the socket, not with an HTTP body: a separate channel with its own (mixed French and English) texts' },
};

function run(producer: Producer): Site[] {
  if ('property' in producer) return producer.file ? project.property(producer.file, producer.property) : project.propertyEverywhere(producer.property);

  if ('call' in producer) return project.callArguments(producer.call, producer.argument, producer.file);

  if ('parameterDefault' in producer) return project.parameterDefault(producer.file, producer.parameterDefault);

  if ('literals' in producer) return [project.literals(producer.file, producer.literals)];

  if ('texts' in producer) return [project.texts(producer.file, producer.texts)];

  return project.pushes(producer.file, producer.pushes);
}

const sites = project.sites();
const viaSites = UNREAD.flatMap((entry) => entry.via.flatMap(run));
const termSites = TERMS.flatMap((term) => run(term.via));
const everySite = [...sites, ...viaSites, ...termSites];

/** Sentence -> where it is written. */
const written = new Map<string, string[]>();

for (const site of everySite) {
  for (const sentence of site.sentences) {
    const places = written.get(sentence.text) ?? [];

    places.push(`${site.file}:${site.line}`);
    written.set(sentence.text, places);
  }
}

/** Expression that could not be read -> how many times it stands. */
const unread = new Map<string, number>();

for (const site of everySite) {
  for (const expression of site.unresolved) {
    const key = `${site.file} :: ${expression}`;

    unread.set(key, (unread.get(key) ?? 0) + 1);
  }
}

const isPattern = (text: string) => text.includes(HOLE);

describe('the scan reads the whole server', () => {
  it('finds a good part of the sources and of the sentences (a scanner that reads nothing would pass everything)', () => {
    expect(SOURCES.length).toBeGreaterThan(200);
    expect([...written.keys()].filter((text) => !isPattern(text)).length).toBeGreaterThan(300);
    expect([...written.keys()].filter(isPattern).length).toBeGreaterThan(40);
  });

  it('read every exception of Nest that the sources build, and says which classes it leaves out', () => {
    const byRegex = new Map<string, number>();
    const zeroArgument = new Map<string, number>();

    for (const { text } of SOURCES) {
      for (const match of stripComments(text).matchAll(/\bnew\s+([A-Za-z]+Exception)\s*\(\s*(\)?)/g)) {
        byRegex.set(match[1], (byRegex.get(match[1]) ?? 0) + 1);

        if (match[2]) zeroArgument.set(match[1], (zeroArgument.get(match[1]) ?? 0) + 1);
      }
    }

    const constructed = project.constructed();

    // two ways of counting (the lexer and a regular expression over the text) agree, class by class
    expect(Object.fromEntries([...constructed].sort())).toEqual(Object.fromEntries([...byRegex].sort()));

    for (const [name, total] of constructed) {
      if (EXCEPTIONS.includes(name)) {
        const read = sites.filter((site) => site.by === name).length;

        // every construction with an argument is a site; one without argument is Nest's own English sentence ("Not Found")
        expect(`${name} ${read + (zeroArgument.get(name) ?? 0)}`).toBe(`${name} ${total}`);
      } else {
        expect(NOT_HTTP[name]).toBeDefined();
        expect(`${name} ${total}`).toBe(`${name} ${NOT_HTTP[name].count}`);
      }
    }

    // a class that is listed as left out but is not built any more is a stale line
    expect(Object.keys(NOT_HTTP).filter((name) => !constructed.has(name))).toEqual([]);
  });

  it('does not leave out an exception that carries a message (Nest default sentences are English and left as they are)', () => {
    const bare = sites.filter((site) => site.sentences.length === 0 && site.unresolved.length === 0 && !site.collected);

    expect(bare.map((site) => `${site.file}:${site.line} ${site.by}`)).toEqual([]);
  });

  it('knows where the sentences of a list thrown whole are pushed', () => {
    const collected = sites.filter((site) => site.collected);

    expect(collected.length).toBeGreaterThan(0);

    for (const site of collected) {
      expect(sites.some((other) => other.file === site.file && other.by === site.collected && other.sentences.length > 0)).toBe(true);
    }
  });

  it('writes no sentence that is only holes', () => {
    const odd = [...written.keys()].filter((text) => isPattern(text) && text.replace(/\{\}/g, '').trim() === '');

    expect(odd).toEqual([]);
  });
});

describe('the sentences that are not written where they are thrown', () => {
  it('are all listed, with their exact count', () => {
    const listed = new Map(UNREAD.map((entry) => [`${entry.file} :: ${entry.expression}`, entry.count]));
    const unlisted = [...unread].filter(([key]) => !listed.has(key)).map(([key, count]) => `${key} (x${count})`);
    const wrongCount = [...listed].filter(([key, count]) => unread.has(key) && unread.get(key) !== count).map(([key, count]) => `${key}: listed ${count}, found ${unread.get(key)}`);

    expect(unlisted).toEqual([]);
    expect(wrongCount).toEqual([]);
  });

  it('are not listed once they stand nowhere (a stale line hides the next one)', () => {
    const stale = UNREAD.filter((entry) => !unread.has(`${entry.file} :: ${entry.expression}`)).map((entry) => `${entry.file} :: ${entry.expression}`);

    expect(stale).toEqual([]);
  });

  it('each tell why and where the sentences come from', () => {
    for (const entry of UNREAD) {
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  });
});

describe('the dictionary and the sentences of the server', () => {
  const keys = Object.keys(ERRORS_AR);

  it('has the Arabic of every sentence the server writes', () => {
    const missing = [...written].filter(([text]) => !(text in ERRORS_AR)).map(([text, places]) => `${places[0]}  ${text}`);

    expect(missing).toEqual([]);
  });

  it('has no sentence that the server does not write any more', () => {
    const orphans = keys.filter((key) => !written.has(key));

    expect(orphans).toEqual([]);
  });
});
