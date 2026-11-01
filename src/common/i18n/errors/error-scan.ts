/**
 * Reads the server sources and lists every French sentence a refused request can carry (P3-04). Test support only: nothing in the
 * application imports it, and the dictionary of Arabic sentences (`errors.ar.ts`) is checked against what it finds.
 *
 * It is a small lexer (strings, templates, comments, regular expressions), not a regular expression over lines, so a sentence
 * written on several lines, a quote inside a template or a `//` inside a string is read as the compiler reads it.
 *
 * Where a sentence is found:
 *
 *  - the first argument of `new BadRequestException(...)` and the other exceptions of Nest, or its `message` when it is an object;
 *  - `issues.push(...)` and `problems.push(...)`: the lists of reasons that go with a refusal;
 *  - the `message` of a validation decorator (`@Matches(re, { message: '...' })`).
 *
 * What it understands there:
 *
 *  - a string or a template without values: a static sentence;
 *  - a template with values, or a `+` between text and something else: a pattern, each value being a hole (`{}`);
 *    a value that is a constant of the file, or a choice between a few texts, is written into the sentence instead;
 *  - a constant (`const NAME = '...'`; an exported one of another file), `NAME.key` or `NAME[x]` of an object or array of texts;
 *  - a call of a function of the sources: the sentences it returns (its parameters are holes);
 *  - `a ? b : c`, `a ?? b`, `a || b`: every branch;
 *  - anything else (a property of a variable...): reported as unresolved, with its source text.
 */

export type TokenKind = 'str' | 'tpl' | 'id' | 'num' | 'p' | 're';

export interface Token {
  kind: TokenKind;
  /** The text of a string (decoded), the name of an identifier, the punctuation, the source of a number or of a regular expression. */
  value: string;
  /** For a template: the texts between the values (decoded), and the source text of each value. */
  quasis?: string[];
  exprs?: string[];
  pos: number;
  /** Where the token ends in the source. */
  end: number;
}

const REGEX_AFTER_PUNCT = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '=>', '...', '??', '&&', '||']);
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do', 'instanceof']);
const IDENT_START = /[A-Za-z_$\u00C0-\uFFFF]/;
const IDENT_PART = /[A-Za-z0-9_$\u00C0-\uFFFF]/;

function decodeEscape(text: string, i: number): { out: string; next: number } {
  const c = text[i + 1];

  switch (c) {
    case 'n':
      return { out: '\n', next: i + 2 };
    case 'r':
      return { out: '\r', next: i + 2 };
    case 't':
      return { out: '\t', next: i + 2 };
    case 'b':
      return { out: '\b', next: i + 2 };
    case 'f':
      return { out: '\f', next: i + 2 };
    case 'v':
      return { out: '\v', next: i + 2 };
    case '0':
      return { out: '\0', next: i + 2 };
    case 'x':
      return { out: String.fromCharCode(parseInt(text.slice(i + 2, i + 4), 16)), next: i + 4 };
    case 'u': {
      if (text[i + 2] === '{') {
        const close = text.indexOf('}', i + 3);

        return { out: String.fromCodePoint(parseInt(text.slice(i + 3, close), 16)), next: close + 1 };
      }

      return { out: String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16)), next: i + 6 };
    }
    case '\r':
      return { out: '', next: text[i + 2] === '\n' ? i + 3 : i + 2 };
    case '\n':
      return { out: '', next: i + 2 };
    default:
      return { out: c ?? '', next: i + 2 };
  }
}

/** Reads tokens from `from`; with `untilBrace` it stops at the `}` that closes the `${` the caller is inside, and gives its index. */
function lex(text: string, from: number, untilBrace: boolean): { tokens: Token[]; end: number } {
  const tokens: Token[] = [];
  let depth = 0;
  let i = from;

  const push = (token: Omit<Token, 'end'>, end: number) => tokens.push({ ...token, end });

  while (i < text.length) {
    const ch = text[i];

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }

    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);

      i = close === -1 ? text.length : close + 2;
      continue;
    }

    if (ch === "'" || ch === '"') {
      const start = i;
      let out = '';

      i += 1;

      while (i < text.length && text[i] !== ch) {
        if (text[i] === '\\') {
          const decoded = decodeEscape(text, i);

          out += decoded.out;
          i = decoded.next;
        } else {
          out += text[i];
          i += 1;
        }
      }

      i += 1;
      push({ kind: 'str', value: out, pos: start }, i);
      continue;
    }

    if (ch === '`') {
      const start = i;
      const quasis: string[] = [];
      const exprs: string[] = [];
      let current = '';

      i += 1;

      while (i < text.length && text[i] !== '`') {
        if (text[i] === '\\') {
          const decoded = decodeEscape(text, i);

          current += decoded.out;
          i = decoded.next;
        } else if (text[i] === '$' && text[i + 1] === '{') {
          const inner = lex(text, i + 2, true);

          quasis.push(current);
          exprs.push(text.slice(i + 2, inner.end));
          current = '';
          i = inner.end + 1;
        } else {
          current += text[i];
          i += 1;
        }
      }

      i += 1;
      quasis.push(current);
      push({ kind: 'tpl', value: quasis.join('${}'), quasis, exprs, pos: start }, i);
      continue;
    }

    if (ch === '/') {
      const before = tokens[tokens.length - 1];
      const regexAllowed =
        !before ||
        (before.kind === 'p' && REGEX_AFTER_PUNCT.has(before.value)) ||
        (before.kind === 'id' && REGEX_AFTER_WORD.has(before.value));

      if (regexAllowed) {
        const start = i;
        let inClass = false;

        i += 1;

        while (i < text.length && (inClass || text[i] !== '/') && text[i] !== '\n') {
          if (text[i] === '\\') i += 1;
          else if (text[i] === '[') inClass = true;
          else if (text[i] === ']') inClass = false;

          i += 1;
        }

        i += 1;

        while (i < text.length && IDENT_PART.test(text[i])) i += 1;

        push({ kind: 're', value: text.slice(start, i), pos: start }, i);
        continue;
      }
    }

    if (IDENT_START.test(ch)) {
      const start = i;

      while (i < text.length && IDENT_PART.test(text[i])) i += 1;

      push({ kind: 'id', value: text.slice(start, i), pos: start }, i);
      continue;
    }

    if (/[0-9]/.test(ch)) {
      const start = i;

      while (i < text.length && /[0-9A-Za-z_.]/.test(text[i])) i += 1;

      push({ kind: 'num', value: text.slice(start, i), pos: start }, i);
      continue;
    }

    if (untilBrace) {
      if (ch === '{') depth += 1;

      if (ch === '}') {
        if (depth === 0) return { tokens, end: i };

        depth -= 1;
      }
    }

    const two = text.slice(i, i + 2);
    const op = text.slice(i, i + 3) === '...' ? '...' : ['=>', '?.', '??', '&&', '||'].includes(two) ? two : ch;

    push({ kind: 'p', value: op, pos: i }, i + op.length);
    i += op.length;
  }

  return { tokens, end: i };
}

export function tokenize(text: string): Token[] {
  return lex(text, 0, false).tokens;
}

// ---------------------------------------------------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------------------------------------------------

const isPunct = (token: Token | undefined, value: string): boolean => token?.kind === 'p' && token.value === value;
const isWord = (token: Token | undefined, value: string): boolean => token?.kind === 'id' && token.value === value;
const OPENERS = '([{';
const CLOSERS = ')]}';

/** The index of the bracket that closes the one at `open`, or -1. */
function closeOf(tokens: readonly Token[], open: number): number {
  let depth = 0;

  for (let i = open; i < tokens.length; i += 1) {
    const t = tokens[i];

    if (t.kind !== 'p') continue;

    if (OPENERS.includes(t.value)) depth += 1;

    if (CLOSERS.includes(t.value)) {
      depth -= 1;

      if (depth === 0) return i;
    }
  }

  return -1;
}

/** The tokens cut at the separators that are not inside a bracket. */
function splitAtTopLevel(tokens: readonly Token[], separator: string): Token[][] {
  const parts: Token[][] = [[]];
  let depth = 0;

  for (const t of tokens) {
    if (t.kind === 'p' && OPENERS.includes(t.value)) depth += 1;

    if (t.kind === 'p' && CLOSERS.includes(t.value)) depth -= 1;

    if (depth === 0 && t.kind === 'p' && t.value === separator) parts.push([]);
    else parts[parts.length - 1].push(t);
  }

  return parts;
}

function indexOfTopLevel(tokens: readonly Token[], punct: string, from = 0): number {
  let depth = 0;

  for (let i = from; i < tokens.length; i += 1) {
    const t = tokens[i];

    if (t.kind !== 'p') continue;

    if (OPENERS.includes(t.value)) depth += 1;

    if (CLOSERS.includes(t.value)) depth -= 1;

    if (depth === 0 && t.value === punct) return i;
  }

  return -1;
}

/** The tokens of an expression that starts at `from`: up to the `;` or `,` that ends it, or the bracket that closes the one around it. */
function expressionFrom(tokens: readonly Token[], from: number): Token[] {
  const out: Token[] = [];
  let depth = 0;

  for (let i = from; i < tokens.length; i += 1) {
    const t = tokens[i];

    if (t.kind === 'p' && OPENERS.includes(t.value)) depth += 1;

    if (t.kind === 'p' && CLOSERS.includes(t.value)) {
      depth -= 1;

      if (depth < 0) break;
    }

    if (depth === 0 && t.kind === 'p' && (t.value === ';' || t.value === ',')) break;

    // a statement that follows without a `;`
    if (depth === 0 && t.kind === 'id' && out.length && /^(const|let|var|function|export|return|if|for|while|throw|class|import|type|interface)$/.test(t.value)) {
      const previous = out[out.length - 1];

      if (!(previous.kind === 'p' && !CLOSERS.includes(previous.value))) break;
    }

    out.push(t);
  }

  return out;
}

function lineOf(text: string, pos: number): number {
  let line = 1;

  for (let i = 0; i < pos && i < text.length; i += 1) if (text[i] === '\n') line += 1;

  return line;
}

// ---------------------------------------------------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------------------------------------------------

/** A sentence the server can write: `text` is exact when `kind` is "static"; a "pattern" has `{}` where a value goes. */
export interface Sentence {
  kind: 'static' | 'pattern';
  text: string;
}

export const HOLE = '{}';

export interface Resolution {
  sentences: Sentence[];
  /** The source text of what could not be read (a property of a variable, a call of something unknown...). */
  unresolved: string[];
}

export interface Site {
  file: string;
  line: number;
  /** "BadRequestException", "issues" or "problems" for a reason pushed into a list, "@Matches" for a validation decorator. */
  by: string;
  sentences: Sentence[];
  unresolved: string[];
  /** The list the exception takes whole (`new BadRequestException(problems)`): its sentences are the ones pushed into it. */
  collected?: string;
}

export interface SourceFile {
  file: string;
  text: string;
}

export const EXCEPTIONS = [
  'BadRequestException',
  'NotFoundException',
  'ForbiddenException',
  'ConflictException',
  'UnauthorizedException',
  'UnprocessableEntityException',
  'ServiceUnavailableException',
  'TooManyRequestsException',
  'GoneException',
  'InternalServerErrorException',
  'PayloadTooLargeException',
  'NotAcceptableException',
  'MethodNotAllowedException',
  'RequestTimeoutException',
  'HttpException',
];

/**
 * The list the code pushes the reasons of a refusal into (`issues.push(...)`, then `{ message, issues }`) wherever it is built.
 * Another list is one of a refusal only in a file that throws it (`throw new BadRequestException(problems)`): see `collectorsOf`.
 */
export const COLLECTORS = ['issues'];

const MAX_ALTERNATIVES = 24;
const NOTHING = new Set(['null', 'undefined', 'true', 'false']);

function sentenceOf(text: string): Sentence {
  return { kind: text.includes(HOLE) ? 'pattern' : 'static', text };
}

// ---------------------------------------------------------------------------------------------------------------------
// What a file declares
// ---------------------------------------------------------------------------------------------------------------------

interface FileFacts {
  file: string;
  text: string;
  tokens: Token[];
  /** `const NAME = <value>` anywhere in the file; a name declared twice keeps every value. */
  constants: Map<string, Token[][]>;
  /** The names a file exports (`export const`, `export function`). */
  exported: Set<string>;
  /** Function name (also a method, or a property holding an arrow) to what it returns, one expression per `return`. */
  functions: Map<string, Token[][]>;
}

function addTo<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key) ?? [];

  list.push(value);
  map.set(key, list);
}

const TYPE_NAMES = new Set(['string', 'number', 'boolean', 'void', 'unknown', 'any', 'never', 'object']);

/** Records what a function returns; the `string` of a type `(x) => string` is a type, not a value. */
function addReturns(functions: Map<string, Token[][]>, name: string, expressions: readonly Token[][]): void {
  for (const expression of expressions) {
    if (expression.length === 1 && expression[0].kind === 'id' && TYPE_NAMES.has(expression[0].value)) continue;

    addTo(functions, name, expression);
  }
}

/** The expressions a function body returns (`return x;`). */
function returnsOf(body: readonly Token[]): Token[][] {
  const out: Token[][] = [];

  for (let i = 0; i < body.length; i += 1) {
    if (isWord(body[i], 'return')) out.push(expressionFrom(body, i + 1));
  }

  return out;
}

/** What the arrow whose `=>` is at `arrow` returns: its expression, or the `return`s of its block. */
function arrowReturns(tokens: readonly Token[], arrow: number): Token[][] {
  const next = tokens[arrow + 1];

  if (!next) return [];

  if (isPunct(next, '{')) {
    const close = closeOf(tokens, arrow + 1);

    return returnsOf(tokens.slice(arrow + 2, close === -1 ? tokens.length : close));
  }

  return [expressionFrom(tokens, arrow + 1)];
}

const NOT_A_METHOD = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'await', 'new', 'super', 'import']);
const DECLARATION_PREFIX = new Set(['private', 'public', 'protected', 'static', 'async', 'readonly']);
const MEMBER_PREFIX = new Set([...DECLARATION_PREFIX, ';', '}', '{']);

function factsOf(file: string, text: string): FileFacts {
  const tokens = tokenize(text);
  const constants = new Map<string, Token[][]>();
  const functions = new Map<string, Token[][]>();
  const exported = new Set<string>();

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];

    if (t.kind !== 'id') continue;

    // const NAME[: Type] = value
    if (t.value === 'const' && tokens[i + 1]?.kind === 'id') {
      const name = tokens[i + 1].value;
      let eq = i + 2;

      if (isPunct(tokens[eq], ':')) {
        let depth = 0;

        for (eq += 1; eq < tokens.length; eq += 1) {
          const q = tokens[eq];

          if (q.kind === 'p' && '<([{'.includes(q.value)) depth += 1;

          if (q.kind === 'p' && '>)]}'.includes(q.value) && !(q.value === '>' && isPunct(tokens[eq - 1], '='))) depth -= 1;

          if (depth <= 0 && q.kind === 'p' && (q.value === '=' || q.value === ';')) break;
        }
      }

      if (isPunct(tokens[eq], '=')) {
        const value = expressionFrom(tokens, eq + 1);

        addTo(constants, name, value);

        if (isWord(tokens[i - 1], 'export')) exported.add(name);

        const arrow = indexOfTopLevel(value, '=>');

        if (arrow !== -1 && (isPunct(value[0], '(') || isWord(value[0], 'async') || (value[0]?.kind === 'id' && arrow === 1))) {
          addReturns(functions, name, arrowReturns(value, arrow));
        }
      }

      continue;
    }

    // function NAME(...) { ... }
    if (t.value === 'function' && tokens[i + 1]?.kind === 'id') {
      const name = tokens[i + 1].value;
      const open = tokens.findIndex((q, k) => k > i + 1 && isPunct(q, '('));
      const close = open === -1 ? -1 : closeOf(tokens, open);
      const brace = close === -1 ? -1 : tokens.findIndex((q, k) => k > close && isPunct(q, '{'));
      const end = brace === -1 ? -1 : closeOf(tokens, brace);

      if (end !== -1) {
        addReturns(functions, name, returnsOf(tokens.slice(brace + 1, end)));

        if (isWord(tokens[i - 1], 'export') || (isWord(tokens[i - 1], 'async') && isWord(tokens[i - 2], 'export'))) exported.add(name);
      }

      continue;
    }

    // a method of a class or of an object: name(...) { ... } after a modifier or a closed member
    if (isPunct(tokens[i + 1], '(') && !NOT_A_METHOD.has(t.value) && MEMBER_PREFIX.has(tokens[i - 1]?.value ?? ';') && tokens[i - 1]?.kind !== 'str') {
      const close = closeOf(tokens, i + 1);
      let brace = close + 1;

      // an optional return type: `: string | null`
      if (isPunct(tokens[brace], ':')) {
        while (brace < tokens.length && !isPunct(tokens[brace], '{') && !isPunct(tokens[brace], ';') && !isPunct(tokens[brace], '=')) brace += 1;
      }

      if (close !== -1 && isPunct(tokens[brace], '{')) {
        const end = closeOf(tokens, brace);

        if (end !== -1) addReturns(functions, t.value, returnsOf(tokens.slice(brace + 1, end)));
      }

      continue;
    }

    // key: (params) => ...   a property that holds an arrow function
    if (isPunct(tokens[i + 1], ':') && (isPunct(tokens[i + 2], '(') || isWord(tokens[i + 2], 'async'))) {
      const start = isWord(tokens[i + 2], 'async') ? i + 3 : i + 2;
      const close = isPunct(tokens[start], '(') ? closeOf(tokens, start) : -1;

      if (close !== -1 && isPunct(tokens[close + 1], '=>')) addReturns(functions, t.value, arrowReturns(tokens, close + 1));
    }
  }

  return { file, text, tokens, constants, exported, functions };
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading an expression
// ---------------------------------------------------------------------------------------------------------------------

export class Reader {
  private readonly active = new Set<string>();

  constructor(
    private readonly facts: FileFacts,
    private readonly project: Project,
  ) {}

  /** Every sentence an expression can give. */
  read(tokens: readonly Token[]): Resolution {
    const result: Resolution = { sentences: [], unresolved: [] };

    this.into(tokens, result);

    return result;
  }

  private sourceOf(tokens: readonly Token[]): string {
    if (!tokens.length) return '';

    return this.facts.text.slice(tokens[0].pos, tokens[tokens.length - 1].end).replace(/\s+/g, ' ').trim();
  }

  private into(rawTokens: readonly Token[], out: Resolution): void {
    let tokens = [...rawTokens];

    // `expr as const`, `expr as string`, `expr!`
    const asAt = tokens.findIndex((t, k) => k > 0 && isWord(t, 'as'));

    if (asAt > 0) tokens = tokens.slice(0, asAt);

    while (tokens.length && isPunct(tokens[tokens.length - 1], '!')) tokens.pop();

    if (!tokens.length) return;

    // `(expr)`
    if (isPunct(tokens[0], '(') && closeOf(tokens, 0) === tokens.length - 1) {
      this.into(tokens.slice(1, -1), out);
      return;
    }

    // a list of texts: each one is a sentence (`['a', 'b']`)
    if (isPunct(tokens[0], '[') && closeOf(tokens, 0) === tokens.length - 1) {
      splitAtTopLevel(tokens.slice(1, -1), ',').forEach((element) => this.into(element, out));
      return;
    }

    // a ternary: `cond ? a : b`; the condition says nothing, each branch is a sentence
    const question = indexOfTopLevel(tokens, '?');

    if (question !== -1) {
      let depth = 0;
      let nested = 0;
      let colon = -1;

      for (let i = question + 1; i < tokens.length; i += 1) {
        const t = tokens[i];

        if (t.kind !== 'p') continue;

        if (OPENERS.includes(t.value)) depth += 1;

        if (CLOSERS.includes(t.value)) depth -= 1;

        if (depth !== 0) continue;

        if (t.value === '?') nested += 1;

        if (t.value === ':') {
          if (nested === 0) {
            colon = i;
            break;
          }

          nested -= 1;
        }
      }

      if (colon !== -1) {
        this.into(tokens.slice(question + 1, colon), out);
        this.into(tokens.slice(colon + 1), out);
        return;
      }
    }

    for (const separator of ['??', '||']) {
      const parts = splitAtTopLevel(tokens, separator);

      if (parts.length > 1) {
        parts.forEach((part) => this.into(part, out));
        return;
      }
    }

    const sum = splitAtTopLevel(tokens, '+');

    if (sum.length > 1) {
      this.concatenate(sum, out);
      return;
    }

    this.single(tokens, out);
  }

  /** `'a' + b + 'c'`: the texts, with a hole for what is not text. A sum with no text at all is not a sentence. */
  private concatenate(parts: Token[][], out: Resolution): void {
    let alternatives: string[] = [''];
    let anyText = false;

    for (const part of parts) {
      const inner = this.read(part);
      const options = inner.sentences.length ? inner.sentences.map((s) => s.text) : [HOLE];

      if (inner.sentences.length) anyText = true;

      alternatives = alternatives.flatMap((prefix) => options.map((option) => prefix + option));

      if (alternatives.length > MAX_ALTERNATIVES) {
        out.unresolved.push(this.sourceOf(parts.flat()));
        return;
      }
    }

    if (!anyText) {
      out.unresolved.push(this.sourceOf(parts.flat()));
      return;
    }

    alternatives.forEach((text) => out.sentences.push(sentenceOf(text)));
  }

  private single(tokens: readonly Token[], out: Resolution): void {
    const first = tokens[0];

    if (tokens.length === 1 && first.kind === 'str') {
      if (first.value !== '') out.sentences.push(sentenceOf(first.value));
      return;
    }

    if (tokens.length === 1 && first.kind === 'tpl') {
      this.template(first, out);
      return;
    }

    if (tokens.length === 1 && first.kind === 'num') return;

    if (tokens.length === 1 && first.kind === 'id') {
      if (!NOTHING.has(first.value)) this.constant(first.value, out);
      return;
    }

    // [] : an empty list, nothing to read
    if (tokens.length === 2 && isPunct(first, '[') && isPunct(tokens[1], ']')) return;

    // a call: name(...), this.name(...), thing.name(...)
    const call = this.callOf(tokens);

    if (call) {
      this.returned(call, tokens, out);
      return;
    }

    // NAME.key, NAME['key'], NAME[expr]: the texts of an object or an array of texts
    if (first.kind === 'id' && tokens.length >= 3 && (isPunct(tokens[1], '.') || isPunct(tokens[1], '[')) && this.member(first.value, tokens.slice(1), out)) return;

    out.unresolved.push(this.sourceOf(tokens));
  }

  private template(token: Token, out: Resolution): void {
    const quasis = [...(token.quasis ?? [])];
    const exprs = [...(token.exprs ?? [])];
    const capitalized = new Set<number>();

    // `${x.charAt(0).toUpperCase()}${x.slice(1)}`: x with a capital, one value
    for (let k = 0; k + 1 < exprs.length; k += 1) {
      const head = /^\s*([A-Za-z_$][\w$.]*)\.charAt\(0\)\.toUpperCase\(\)\s*$/.exec(exprs[k]);

      if (head && quasis[k + 1] === '' && new RegExp(`^\\s*${head[1].replace(/[.$]/g, '\\$&')}\\.slice\\(1\\)\\s*$`).test(exprs[k + 1])) {
        exprs.splice(k, 2, head[1]);
        quasis.splice(k + 1, 1);
        capitalized.add(k);
      }
    }

    let alternatives: string[] = [quasis[0]];

    for (let k = 0; k < exprs.length; k += 1) {
      const inner = this.read(tokenize(exprs[k]));
      // a value that is one of a few known texts is written in; any other value is a hole
      // (a pattern that is only holes and separators, such as an amount and its currency, stays one hole)
      const known =
        inner.sentences.length > 0 &&
        inner.unresolved.length === 0 &&
        inner.sentences.length <= 4 &&
        inner.sentences.every((s) => s.kind === 'static' || /\p{L}/u.test(s.text.split(HOLE).join('')));
      const texts = known ? inner.sentences.map((s) => s.text) : [HOLE];
      const options = capitalized.has(k) ? texts.map((text) => text.charAt(0).toUpperCase() + text.slice(1)) : texts;

      alternatives = alternatives.flatMap((prefix) => options.map((option) => prefix + option + quasis[k + 1]));
    }

    if (alternatives.length > MAX_ALTERNATIVES) {
      out.unresolved.push(`a template with too many alternatives: ${token.value}`);
      return;
    }

    alternatives.forEach((text) => out.sentences.push(sentenceOf(text)));
  }

  private constantValues(name: string): Token[][] | undefined {
    return this.facts.constants.get(name) ?? this.project.exportedConstant(name);
  }

  private constant(name: string, out: Resolution): void {
    const declared = this.constantValues(name);

    if (!declared || this.active.has(`const:${name}`)) {
      out.unresolved.push(name);
      return;
    }

    this.active.add(`const:${name}`);

    try {
      for (const value of declared) {
        const inner = this.read(value);

        // A constant that holds no text (a number, an object, a list) is not a sentence: it stays unresolved under its name
        if (!inner.sentences.length && !inner.unresolved.length && !(value.length === 2 && isPunct(value[0], '['))) out.unresolved.push(name);

        out.sentences.push(...inner.sentences);
        out.unresolved.push(...inner.unresolved);
      }
    } finally {
      this.active.delete(`const:${name}`);
    }
  }

  /** The name of the function a call expression calls, when the tokens are exactly one call: `f(x)`, `this.f(x)`, `a.b.f(x)`. */
  private callOf(tokens: readonly Token[]): string | null {
    const open = tokens.findIndex((t, k) => k > 0 && isPunct(t, '('));

    if (open < 1 || tokens[open - 1].kind !== 'id' || closeOf(tokens, open) !== tokens.length - 1) return null;

    for (let k = 0; k < open; k += 1) {
      const expected = k % 2 === 0 ? tokens[k].kind === 'id' : isPunct(tokens[k], '.');

      if (!expected) return null;
    }

    return tokens[open - 1].value;
  }

  private returned(name: string, tokens: readonly Token[], out: Resolution): void {
    const own = this.facts.functions.get(name);
    const declared = own ?? this.project.exportedFunction(name);

    if (!declared || this.active.has(`fn:${name}`)) {
      out.unresolved.push(this.sourceOf(tokens));
      return;
    }

    this.active.add(`fn:${name}`);

    try {
      const owner = own ? this : this.project.readerFor(name);

      for (const expression of declared) {
        const inner = owner.read(expression);

        out.sentences.push(...inner.sentences);
        out.unresolved.push(...inner.unresolved);
      }
    } finally {
      this.active.delete(`fn:${name}`);
    }
  }

  /** `NAME.key` or `NAME[...]` where NAME is a constant object/array: the text(s) it holds. Returns false when it is not one. */
  private member(name: string, rest: readonly Token[], out: Resolution): boolean {
    const declared = this.constantValues(name);
    const body = declared?.[0];

    if (!body || !(isPunct(body[0], '{') || isPunct(body[0], '['))) return false;

    // NAME.key: the value of that key
    if (isPunct(rest[0], '.') && rest[1]?.kind === 'id' && rest.length === 2 && isPunct(body[0], '{')) {
      for (const entry of splitAtTopLevel(body.slice(1, -1), ',')) {
        if (entry[0] && entry[0].value === rest[1].value && isPunct(entry[1], ':')) {
          this.into(entry.slice(2), out);
          return true;
        }
      }
    }

    const texts = body.filter((t) => t.kind === 'str' || (t.kind === 'tpl' && !(t.exprs ?? []).length)).map((t) => t.value);

    if (!texts.length) return false;

    texts.forEach((text) => out.sentences.push(sentenceOf(text)));

    return true;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The whole source tree
// ---------------------------------------------------------------------------------------------------------------------

/** The value of `message` in the tokens of an object literal (between its braces), or null when there is no such key. */
function propertyOfObject(inner: readonly Token[], name: string): Token[] | null {
  for (const entry of splitAtTopLevel(inner, ',')) {
    const key = entry[0];

    if (!key || key.value !== name || (key.kind !== 'id' && key.kind !== 'str')) continue;

    // `name: <expr>`, or the shorthand `name`
    if (entry.length === 1) return [key];

    if (isPunct(entry[1], ':')) return entry.slice(2);
  }

  return null;
}

function isObjectLiteral(tokens: readonly Token[]): boolean {
  return isPunct(tokens[0], '{') && closeOf(tokens, 0) === tokens.length - 1;
}

/**
 * The lists of reasons of a file: `issues`, and any list that the file declares empty (`const problems: string[] = []`) and
 * hands to an exception whole (`throw new BadRequestException(problems)`), so that what is pushed into it is a sentence of a refusal.
 */
function collectorsOf(facts: FileFacts): string[] {
  const names = [...COLLECTORS];

  for (const [name, values] of facts.constants) {
    if (!values.some((value) => value.length === 2 && isPunct(value[0], '[') && isPunct(value[1], ']'))) continue;

    const thrown = facts.tokens.some(
      (t, i) => isWord(t, 'new') && EXCEPTIONS.includes(facts.tokens[i + 1]?.value) && isPunct(facts.tokens[i + 2], '(') && isWord(facts.tokens[i + 3], name) && isPunct(facts.tokens[i + 4], ')'),
    );

    if (thrown) names.push(name);
  }

  return names;
}

export class Project {
  private readonly facts: FileFacts[];
  private readonly readers = new Map<string, Reader>();
  private readonly constantsByName = new Map<string, Token[][]>();
  private readonly functionsByName = new Map<string, { file: string; returns: Token[][] }[]>();

  constructor(files: readonly SourceFile[]) {
    this.facts = files.map(({ file, text }) => factsOf(file, text));

    for (const facts of this.facts) {
      for (const name of facts.exported) {
        facts.constants.get(name)?.forEach((value) => addTo(this.constantsByName, name, value));

        const returns = facts.functions.get(name);

        if (returns?.length) addTo(this.functionsByName, name, { file: facts.file, returns });
      }
    }
  }

  exportedConstant(name: string): Token[][] | undefined {
    return this.constantsByName.get(name);
  }

  exportedFunction(name: string): Token[][] | undefined {
    const found = this.functionsByName.get(name);

    return found ? found.flatMap((entry) => entry.returns) : undefined;
  }

  /** A reader that resolves the names the way the file that exports the function does (its own constants first). */
  readerFor(name: string): Reader {
    const file = this.functionsByName.get(name)?.[0]?.file;

    return file ? this.reader(this.facts.find((f) => f.file === file) as FileFacts) : this.reader(this.facts[0]);
  }

  private reader(facts: FileFacts): Reader {
    let reader = this.readers.get(facts.file);

    if (!reader) {
      reader = new Reader(facts, this);
      this.readers.set(facts.file, reader);
    }

    return reader;
  }

  /** How many times each class of exception is constructed (`new XxxException(`), the ones this file does not read included. */
  constructed(): Map<string, number> {
    const counts = new Map<string, number>();

    for (const { tokens } of this.facts) {
      tokens.forEach((t, i) => {
        const named = tokens[i + 1];

        if (isWord(t, 'new') && named?.kind === 'id' && named.value.endsWith('Exception') && isPunct(tokens[i + 2], '(')) counts.set(named.value, (counts.get(named.value) ?? 0) + 1);
      });
    }

    return counts;
  }

  /** Every exception thrown, every reason pushed into a list of reasons, every validation message. */
  sites(): Site[] {
    const sites: Site[] = [];

    for (const facts of this.facts) {
      const { tokens, text, file } = facts;
      const reader = this.reader(facts);
      const collectors = collectorsOf(facts);

      const add = (by: string, at: Token, expression: readonly Token[]) => {
        const { sentences, unresolved } = reader.read(expression);

        sites.push({ file, line: lineOf(text, at.pos), by, sentences, unresolved });
      };

      for (let i = 0; i < tokens.length; i += 1) {
        const t = tokens[i];

        // new XxxException(<first argument>)
        if (isWord(t, 'new') && tokens[i + 1]?.kind === 'id' && EXCEPTIONS.includes(tokens[i + 1].value) && isPunct(tokens[i + 2], '(')) {
          const close = closeOf(tokens, i + 2);
          const first = splitAtTopLevel(tokens.slice(i + 3, close), ',')[0] ?? [];
          const by = tokens[i + 1].value;

          // new NotFoundException(): Nest's own sentence, in English
          if (!first.length) continue;

          if (isObjectLiteral(first)) {
            const inner = first.slice(1, -1);
            const message = propertyOfObject(inner, 'message');

            if (message) add(by, t, message);
            else sites.push({ file, line: lineOf(text, t.pos), by, sentences: [], unresolved: ['an object without message'] });

            // the reasons that go with it: `issues`, a shorthand for a list the code filled with `issues.push`
            const reasons = propertyOfObject(inner, 'issues');

            if (reasons && !(reasons.length === 1 && collectors.includes(reasons[0].value))) add(`${by} issues`, t, reasons);
          } else if (first.length === 1 && collectors.includes(first[0].value)) {
            sites.push({ file, line: lineOf(text, t.pos), by, sentences: [], unresolved: [], collected: first[0].value });
          } else {
            add(by, t, first);
          }

          continue;
        }

        // issues.push(<reason>, ...)
        if (t.kind === 'id' && collectors.includes(t.value) && isPunct(tokens[i + 1], '.') && isWord(tokens[i + 2], 'push') && isPunct(tokens[i + 3], '(')) {
          const close = closeOf(tokens, i + 3);

          splitAtTopLevel(tokens.slice(i + 4, close), ',').forEach((argument) => add(t.value, t, argument));
          continue;
        }

        // @Matches(re, { message: '...' }) : the message of a validation decorator
        if (isPunct(t, '@') && tokens[i + 1]?.kind === 'id' && isPunct(tokens[i + 2], '(')) {
          const close = closeOf(tokens, i + 2);

          for (const argument of splitAtTopLevel(tokens.slice(i + 3, close), ',')) {
            if (!isObjectLiteral(argument)) continue;

            const message = propertyOfObject(argument.slice(1, -1), 'message');

            if (message) add(`@${tokens[i + 1].value}`, t, message);
          }
        }
      }
    }

    return sites;
  }

  /** The sentences of the property `name` of the object literals of a file: where a helper keeps the words a refusal uses. */
  property(file: string, name: string): Site[] {
    const facts = this.facts.find((f) => f.file === file);

    if (!facts) throw new Error(`No such source: ${file}`);

    const reader = this.reader(facts);
    const out: Site[] = [];

    for (let i = 1; i + 1 < facts.tokens.length; i += 1) {
      const t = facts.tokens[i];

      if (t.value !== name || (t.kind !== 'id' && t.kind !== 'str') || !isPunct(facts.tokens[i + 1], ':')) continue;

      if (!(isPunct(facts.tokens[i - 1], '{') || isPunct(facts.tokens[i - 1], ','))) continue;

      const value = expressionFrom(facts.tokens, i + 2);

      // `refusal: string;` in an interface is a type, not a value
      if (value.length === 1 && value[0].kind === 'id' && TYPE_NAMES.has(value[0].value)) continue;

      const { sentences, unresolved } = reader.read(value);

      out.push({ file, line: lineOf(facts.text, t.pos), by: `${name}:`, sentences, unresolved });
    }

    return out;
  }

  /** The sentences of the property `name` of the object literals of every source: an option a caller gives. */
  propertyEverywhere(name: string): Site[] {
    return this.facts.flatMap((facts) => (facts.tokens.some((t) => t.value === name) ? this.property(facts.file, name) : []));
  }

  /** The sentences pushed into a list of a file (`parts.push('...')`): where a function that joins them gets its words. */
  pushes(file: string, list: string): Site[] {
    const facts = this.facts.find((f) => f.file === file);

    if (!facts) throw new Error(`No such source: ${file}`);

    const reader = this.reader(facts);
    const out: Site[] = [];

    facts.tokens.forEach((t, i) => {
      if (!(isWord(t, list) && isPunct(facts.tokens[i + 1], '.') && isWord(facts.tokens[i + 2], 'push') && isPunct(facts.tokens[i + 3], '('))) return;

      const close = closeOf(facts.tokens, i + 3);

      for (const argument of splitAtTopLevel(facts.tokens.slice(i + 4, close), ',')) {
        if (!argument.length) continue; // the trailing comma of a call written on several lines

        const { sentences, unresolved } = reader.read(argument);

        out.push({ file, line: lineOf(facts.text, t.pos), by: `${list}.push`, sentences, unresolved });
      }
    });

    return out;
  }

  /** Texts that a file holds as string literals, for words listed by hand: each must be there, so that a renamed word fails the spec. */
  literals(file: string, values: readonly string[]): Site {
    const facts = this.facts.find((f) => f.file === file);

    if (!facts) throw new Error(`No such source: ${file}`);

    const held = new Set(facts.tokens.filter((t) => t.kind === 'str').map((t) => t.value));
    const missing = values.filter((value) => !held.has(value));

    if (missing.length) throw new Error(`${file} does not hold the text(s): ${missing.join(' | ')}`);

    return { file, line: 0, by: 'literals', sentences: values.map((value) => ({ kind: 'static', text: value })), unresolved: [] };
  }

  /** The sentence a parameter takes when the caller gives none (`function f(a, words = 'Non.')`). */
  parameterDefault(file: string, name: string): Site[] {
    const facts = this.facts.find((f) => f.file === file);

    if (!facts) throw new Error(`No such source: ${file}`);

    const reader = this.reader(facts);
    const out: Site[] = [];

    facts.tokens.forEach((t, i) => {
      if (!(isWord(t, name) && isPunct(facts.tokens[i + 1], '=') && (isPunct(facts.tokens[i - 1], ',') || isPunct(facts.tokens[i - 1], '(')))) return;

      const { sentences, unresolved } = reader.read(expressionFrom(facts.tokens, i + 2));

      out.push({ file, line: lineOf(facts.text, t.pos), by: `${name} =`, sentences, unresolved });
    });

    return out;
  }

  /** The sentences of the arguments at position `index` in the calls of a function (in one file, or in all): where a caller gives the words of a refusal. */
  callArguments(name: string, index: number, file?: string): Site[] {
    const out: Site[] = [];

    for (const facts of this.facts) {
      if (file && facts.file !== file) continue;

      const reader = this.reader(facts);

      for (let i = 0; i + 1 < facts.tokens.length; i += 1) {
        const t = facts.tokens[i];

        if (t.kind !== 'id' || t.value !== name || !isPunct(facts.tokens[i + 1], '(')) continue;

        const close = closeOf(facts.tokens, i + 1);

        // a declaration is not a call: `function name(...)`, `private name(...) {`
        if (isWord(facts.tokens[i - 1], 'function') || DECLARATION_PREFIX.has(facts.tokens[i - 1]?.value ?? '') || isPunct(facts.tokens[close + 1], '{')) continue;

        const argument = splitAtTopLevel(facts.tokens.slice(i + 2, close), ',')[index];

        if (!argument?.length) continue;

        const { sentences, unresolved } = reader.read(argument);

        out.push({ file: facts.file, line: lineOf(facts.text, t.pos), by: `${name}(...)`, sentences, unresolved });
      }
    }

    return out;
  }

  /** The sentences of a function: what its `return`s give. */
  returns(file: string, name: string): Site {
    const facts = this.facts.find((f) => f.file === file);
    const declared = facts?.functions.get(name);

    if (!facts || !declared) throw new Error(`No such function: ${file} ${name}`);

    const reader = this.reader(facts);
    const site: Site = { file, line: 0, by: `${name}()`, sentences: [], unresolved: [] };

    for (const expression of declared) {
      const { sentences, unresolved } = reader.read(expression);

      site.sentences.push(...sentences);
      site.unresolved.push(...unresolved);
    }

    return site;
  }

  /** The texts of a constant object or array. */
  texts(file: string, name: string): Site {
    const facts = this.facts.find((f) => f.file === file);
    const body = facts?.constants.get(name)?.[0];

    if (!facts || !body) throw new Error(`No such constant: ${file} ${name}`);

    const site: Site = { file, line: 0, by: name, sentences: [], unresolved: [] };
    const reader = this.reader(facts);

    // a string, or an object/array whose values are texts, templates or calls
    if (!(isPunct(body[0], '{') || isPunct(body[0], '['))) {
      const { sentences, unresolved } = reader.read(body);

      site.sentences.push(...sentences);
      site.unresolved.push(...unresolved);
      return site;
    }

    const separator = ',';
    const entries = splitAtTopLevel(body.slice(1, -1), separator);

    for (const entry of entries) {
      const colon = isPunct(body[0], '{') ? indexOfTopLevel(entry, ':') : -1;
      const value = colon === -1 ? entry : entry.slice(colon + 1);

      if (!value.length) continue;

      const { sentences, unresolved } = reader.read(value);

      site.sentences.push(...sentences);
      site.unresolved.push(...unresolved);
    }

    return site;
  }
}

export function scanSources(files: readonly SourceFile[]): Site[] {
  return new Project(files).sites();
}
