import * as fs from 'fs';
import * as path from 'path';

/**
 * P1-03 (step 4) guard: a phone number is never written on its own.
 *
 * `User.phoneKey` carries the UNIQUE constraint, so every write of `User.phone`
 * has to write the key with it (through phoneColumns()). Otherwise one code path
 * that forgets is enough to put two accounts on one number, or to leave a number
 * nobody can find again. This reads the source and looks at every write to the
 * User table (update / updateMany / upsert / create / createMany, also nested
 * `user: { create: ... }`):
 *  - if the data mentions `phone` (outside select / include), it must also carry
 *    the key: phoneColumns(...), a `phoneKey` entry, or a reviewed spread;
 *  - a spread or a variable used as `data` is refused unless reviewed below,
 *    because it may carry a phone that nobody looked at.
 *
 * It is a text scan, not a type check: it stops mistakes, not someone determined.
 */

const ROOT = path.resolve(__dirname, '../../..');

/**
 * Text that proves the key is written together with the number. It only counts
 * inside the data that is written: `where: { phoneKey: ... }` proves nothing.
 */
const KEY_EVIDENCE = [
  /phoneColumns\(/,
  /\bphoneKey\b/,
  /\.\.\.phoneCols\b/,
  /\.\.\.change\.data\b/,
];

/** `const phone = phoneColumns(...)` / `= await this.claimPhone(...)`: a variable made by the code that writes the key. */
const KEY_MAKERS = /\b(?:phoneColumns|claimPhone)\s*\(/;

const REVIEWED: Record<string, string> = {
  // create(): the number goes through claimPhone() -> phoneColumns()
  'src/modules/users/users.service.ts:...data': 'const phoneCols = await this.claimPhone(data.phone);',
  // updateProfile(): email and phone are taken out of the input first, the phone is handled below
  'src/modules/users/users.service.ts:data': 'const { email, phone, ...rest } = updateData;',
  // updateByAdmin(): same, and the contact columns come from prepareAdminChange()
  'src/modules/users/users.service.ts:...rest': 'const { email, phone, ...rest } = data;',
  // confirmPhoneChange(): the columns were made by phoneColumns() from the stored value
  'src/modules/users/contact-change.service.ts:...columns': 'const columns = phoneColumns(record.newValue);',
  // editClient(): the contact columns come from prepareAdminChange()
  'src/modules/admin/admin.service.ts:...change.data': 'await this.contactChange.prepareAdminChange(current, {',
};

function listSources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'generated') continue;

    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      listSources(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      out.push(full);
    }
  }

  return out;
}

function stripComments(text: string): string {
  // Comments go, their line breaks stay: line numbers in the report must be the file's.
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ''))
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function balanced(text: string, open: number): string {
  const opener = text[open];
  const closer = opener === '(' ? ')' : opener === '{' ? '}' : ']';
  let depth = 0;

  for (let i = open; i < text.length; i++) {
    if (text[i] === opener) depth++;
    if (text[i] === closer) depth--;
    if (depth === 0) return text.slice(open + 1, i);
  }

  return text.slice(open + 1);
}

/** Removes `select: {...}` and `include: {...}`: they read columns, they do not write them. `where` too: it finds rows, it writes nothing. */
function withoutReads(text: string): string {
  let result = text;
  const reads = /\b(select|include|where)\s*:\s*\{/g;
  let match: RegExpExecArray | null;

  while ((match = reads.exec(result))) {
    const open = result.indexOf('{', match.index);
    const inner = balanced(result, open);
    result = result.slice(0, match.index) + result.slice(open + inner.length + 2);
    reads.lastIndex = match.index;
  }

  return result;
}

type Write = { file: string; line: number; body: string };

function findUserWrites(file: string, text: string): Write[] {
  const writes: Write[] = [];
  const direct = /\.user\s*\.(create|createMany|update|updateMany|upsert)\s*\(/g;
  const nested = /\buser\s*:\s*\{\s*(create|update|upsert|connectOrCreate)\s*:/g;

  for (const pattern of [direct, nested]) {
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text))) {
      const open = pattern === direct ? text.indexOf('(', match.index) : text.indexOf('{', match.index);
      const body = withoutReads(balanced(text, open));

      writes.push({ file, line: text.slice(0, match.index).split('\n').length, body });
    }
  }

  return writes;
}

export type Problems = { missing: string[]; unreviewed: string[] };

/** True when `name` is a variable the same file made with phoneColumns() / claimPhone(). */
function madeByKeyMaker(source: string, name: string): boolean {
  const pattern = new RegExp(`\\b(?:(?:const|let)\\s+)?${name.replace(/\./g, '\\.')}\\s*(?::[^=;]+)?=\\s*(?:await\\s+)?(?:this\\.)?[\\w.]*?${KEY_MAKERS.source}`);

  return pattern.test(source);
}

/** The values of the top-level `data`, `create` and `update` of a write, and the variable itself when a bare one is passed. */
function writtenValues(body: string): string[] {
  let text = body.trim();

  // .update({ ... }) -> the object's content; nested `create: {...}` has no braces of its own
  if (text.startsWith('{') && balanced(text, 0).length === text.length - 2) {
    text = text.slice(1, -1).trim();
  }

  const values: string[] = [];
  let depth = 0;

  for (let i = 0; i < text.length; i++) {
    if ('({['.includes(text[i])) depth++;
    if (')}]'.includes(text[i])) depth--;

    if (depth !== 0 || /[\w$]/.test(text[i - 1] ?? ' ')) continue;

    const key = text.slice(i).match(/^(data|create|update)\b\s*(:\s*)?/);

    if (!key) continue;

    // `data,` / `data }` is the shorthand for `data: data`
    values.push(key[2] ? text.slice(i + key[0].length) : 'data');
  }

  // .update(args): nothing says what is written
  if (values.length === 0 && /^[A-Za-z_$][\w$.]*$/.test(text)) values.push(text);

  return values;
}

export function checkWrites(writes: Write[], sources: Map<string, string>): Problems {
  const missing = writes
    .filter((write) => /\bphone\b/.test(write.body))
    .filter((write) => !KEY_EVIDENCE.some((evidence) => evidence.test(write.body)))
    .filter((write) => !hasMadeSpread(write, sources))
    .map((write) => `${write.file}:${write.line}`);

  const unreviewed: string[] = [];

  for (const write of writes) {
    const source = sources.get(write.file) ?? '';

    for (const value of writtenValues(write.body)) {
      const suspects: string[] = [];

      if (value.startsWith('{')) {
        // top-level spreads of the object literal
        const literal = balanced(value, 0);
        let depth = 0;

        for (let i = 0; i < literal.length; i++) {
          if ('({['.includes(literal[i])) depth++;
          if (')}]'.includes(literal[i])) depth--;

          if (depth === 0 && literal.startsWith('...', i)) {
            const spread = literal.slice(i).match(/^\.\.\.[\w.]+\(?/);
            if (spread) suspects.push(spread[0]);
          }
        }
      } else {
        // data: someVariable, data: rows.map(...), or the shorthand
        suspects.push(value.match(/^([\w$.]+)/)?.[1] ?? value.trim().slice(0, 20));
      }

      for (const suspect of suspects) {
        if (KEY_EVIDENCE.some((evidence) => evidence.test(suspect))) continue;

        // "...phone" made by `const phone = phoneColumns(...)` in this file
        if (suspect.startsWith('...') && madeByKeyMaker(source, suspect.slice(3))) continue;

        const marker = REVIEWED[`${write.file}:${suspect}`];

        if (marker && source.includes(marker)) continue;

        unreviewed.push(`${write.file}:${write.line} (${suspect})`);
      }
    }
  }

  return { missing, unreviewed };
}

function hasMadeSpread(write: Write, sources: Map<string, string>): boolean {
  const source = sources.get(write.file) ?? '';

  return [...write.body.matchAll(/\.\.\.([A-Za-z_$][\w$]*)\b(?!\()/g)].some((m) => madeByKeyMaker(source, m[1]));
}

/** Raw SQL that touches the phone columns bypasses every check above. */
export function rawPhoneSql(file: string, text: string): string[] {
  const found: string[] = [];

  for (const match of text.matchAll(/\$(?:execute|query)Raw(?:Unsafe)?\b/g)) {
    const around = text.slice(match.index!, match.index! + 600);

    if (/\bphone(Key)?\b/i.test(around)) {
      found.push(`${file}:${text.slice(0, match.index).split('\n').length}`);
    }
  }

  return found;
}

describe('phone writes (P1-03, step 4)', () => {
  const files = [
    ...listSources(path.join(ROOT, 'src')),
    path.join(ROOT, 'prisma/seed.ts'),
    ...listSources(path.join(ROOT, 'scripts')),
  ].filter((file) => fs.existsSync(file));

  const writes: Write[] = [];
  const sources = new Map<string, string>();
  const raw: string[] = [];

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const text = stripComments(content);
    const rel = path.relative(ROOT, file);

    sources.set(rel, content);
    writes.push(...findUserWrites(rel, text));
    raw.push(...rawPhoneSql(rel, text));
  }

  it('finds the User writes it is supposed to guard', () => {
    // If the scan finds almost nothing, the guard would pass for the wrong reason.
    expect(writes.length > 15).toBe(true);
  });

  it('writes the key with every phone number', () => {
    expect(checkWrites(writes, sources).missing.join('\n')).toBe('');
  });

  it('does not hide a phone number in a spread or a variable nobody reviewed', () => {
    expect(checkWrites(writes, sources).unreviewed.join('\n')).toBe('');
  });

  it('no raw SQL touches the phone columns', () => {
    expect(raw.join('\n')).toBe('');
  });

  describe('the scan catches the usual mistakes', () => {
    const check = (code: string) => {
      const sources = new Map([['x.ts', code]]);
      return checkWrites(findUserWrites('x.ts', stripComments(code)), sources);
    };

    it('a phone written without its key', () => {
      expect(check('await tx.user.update({ where: { id }, data: { phone: dto.phone } });').missing.length).toBe(1);
      expect(check('await tx.user\n  .create({ data: { name, phone } });').missing.length).toBe(1);
      expect(check('await tx.user.createMany({ data: rows.map((r) => ({ phone: r.phone })) });').missing.length).toBe(1);
      expect(check('await tx.artisan.create({ data: { user: { create: { name, phone } } } });').missing.length).toBe(1);
    });

    it('a key in the where clause is not a key in the data', () => {
      expect(check('await prisma.user.updateMany({ where: { phoneKey: null }, data: { phone: x } });').missing.length).toBe(1);
      expect(check('await prisma.user.update({ where: { phoneKey: key }, data: { phone: x, ...phoneColumns(x) } });').missing.length).toBe(0);
    });

    it('a phone written with its key passes', () => {
      expect(check('await prisma.user.update({ where: { id }, data: { ...phoneColumns(p) } });').missing.length).toBe(0);
      expect(check('await prisma.user.create({ data: { name, phone: p, phoneKey: k } });').missing.length).toBe(0);
      expect(check('const phone = phoneColumns(p);\nawait prisma.user.create({ data: { name, ...phone } });').unreviewed.length).toBe(0);
      expect(check('const cols = await this.claimPhone(p);\nawait prisma.user.create({ data: { name, ...cols } });').unreviewed.length).toBe(0);
    });

    it('a spread or a variable that nobody made with the key is refused', () => {
      expect(check('await prisma.user.update({ where: { id }, data: { ...dto } });').unreviewed.length).toBe(1);
      expect(check('await prisma.user.update({ where: { id }, data });').unreviewed.length).toBe(1);
      expect(check('const phone = dto.phone;\nawait prisma.user.update({ where: { id }, data: { ...phone } });').unreviewed.length).toBe(1);
      expect(check('await prisma.user.upsert({ where: { id }, create: { ...dto }, update: {} });').unreviewed.length).toBe(1);
    });

    it('raw SQL on the phone columns', () => {
      expect(rawPhoneSql('x.ts', 'await prisma.$executeRaw`UPDATE "User" SET phone = ${p}`;').length).toBe(1);
      expect(rawPhoneSql('x.ts', 'await prisma.$queryRaw`SELECT 1`;').length).toBe(0);
    });
  });
});
