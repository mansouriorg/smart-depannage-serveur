import * as fs from 'fs';
import * as path from 'path';

/**
 * P1-01 guard: nothing writes `Intervention.status` except transitionStatus().
 *
 * It reads the source files and looks at every write to an intervention:
 *  - an update / updateMany / upsert whose data mentions `status` anywhere
 *    (plain, quoted or computed key, nested), uses a spread, or is not an
 *    object literal, fails;
 *  - a create may only set `status: initialStatus()`;
 *  - a nested write (`intervention: { update: ... }` from another model) that
 *    mentions `status` fails;
 *  - raw SQL on the Intervention table fails.
 *
 * So a new endpoint cannot skip the status table by accident. It is a text
 * scan, not a type check: it stops mistakes, not someone determined.
 */

const SRC = path.resolve(__dirname, '../..');

/**
 * `data: someVariable` is fine only for these, and only while the file still
 * contains the marker line that proves the status was split out before.
 */
const REVIEWED_DATA_VARIABLES: Record<string, string> = {
  // transitionStatus builds `nextData` itself (and refuses `status` in its inputs)
  'modules/intervention-workflow/transition-status.ts:nextData':
    "'transitionStatus: pass the new status in `to`, not in `data`.'",
  // staff / artisan update: status and artisanId are taken out of the DTO first
  'modules/interventions/interventions.service.ts:data as any':
    'const { artisanId, status, ...rest } = updateInterventionDto;',
};

function listSources(dir: string): string[] {
  const out: string[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      out.push(...listSources(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      out.push(full);
    }
  }

  return out;
}

/** Text between the bracket at `open` and its matching close (exclusive). */
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

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** The value of `key:` at depth 0 of an object literal body: literal text or expression. */
function valueOfKey(body: string, key: string): { literal: boolean; text: string } | null {
  let depth = 0;

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];

    if ('({['.includes(ch)) depth++;
    if (')}]'.includes(ch)) depth--;

    if (depth !== 0) continue;

    const rest = body.slice(i);
    const match = new RegExp(`^${key}\\s*:\\s*`).exec(rest);
    const before = i === 0 ? ' ' : body[i - 1];

    if (match && /[\s,{]/.test(before)) {
      const start = i + match[0].length;

      if (body[start] === '{') {
        return { literal: true, text: balanced(body, start) };
      }

      let end = start;
      let d = 0;
      for (; end < body.length; end++) {
        const c = body[end];
        if ('({['.includes(c)) d++;
        if (')}]'.includes(c)) d--;
        if (d < 0 || (d === 0 && (c === ',' || c === '\n'))) break;
      }

      return { literal: false, text: body.slice(start, end).trim() };
    }
  }

  return null;
}

export type Finding = { file: string; problem: string };

/** All the problems in one source file. `updates` counts the writes it looked at. */
export function scanSource(rel: string, source: string): { findings: Finding[]; writes: number } {
  const text = stripComments(source);
  const findings: Finding[] = [];
  let writes = 0;

  const callPattern = /\bintervention\.(update|updateMany|upsert|create|createMany)\s*\(/g;
  let match: RegExpExecArray | null;

  while ((match = callPattern.exec(text))) {
    writes++;

    const method = match[1];
    const args = balanced(text, match.index + match[0].length - 1);
    const objectStart = args.indexOf('{');

    if (args.trim()[0] !== '{' || objectStart < 0) {
      findings.push({
        file: rel,
        problem: `intervention.${method}() with arguments that are not an object literal`,
      });
      continue;
    }

    const body = balanced(args, objectStart);
    const keys = method === 'upsert' ? ['create', 'update'] : ['data'];

    for (const key of keys) {
      const value = valueOfKey(body, key);

      if (!value) continue;

      if (!value.literal) {
        const marker = REVIEWED_DATA_VARIABLES[`${rel}:${value.text}`];

        if (!marker || !source.includes(marker)) {
          findings.push({
            file: rel,
            problem: `intervention.${method}() with \`${key}: ${value.text}\`: cannot tell if it writes status`,
          });
        }
        continue;
      }

      if (method === 'create' || method === 'createMany' || (method === 'upsert' && key === 'create')) {
        const mentions = (value.text.match(/\bstatus\b/g) ?? []).length;
        const allowed = (value.text.match(/\bstatus\s*:\s*initialStatus\(/g) ?? []).length;

        if (mentions > allowed) {
          findings.push({ file: rel, problem: 'creates an intervention with a status other than initialStatus()' });
        }
        continue;
      }

      if (/\bstatus\b/.test(value.text)) {
        findings.push({ file: rel, problem: `writes \`status\` directly in intervention.${method}()` });
      }

      if (/\.\.\./.test(value.text)) {
        findings.push({
          file: rel,
          problem: `intervention.${method}() data uses a spread: cannot tell if it writes status`,
        });
      }
    }
  }

  // intervention: { update: { ... status ... } } written from another model
  const nested = /\bintervention\s*:\s*\{\s*(update|upsert|create|connectOrCreate|updateMany)\s*:/g;

  while ((match = nested.exec(text))) {
    writes++;
    const open = text.indexOf('{', match.index);
    const inner = balanced(text, open);

    if (/\bstatus\b/.test(inner)) {
      findings.push({ file: rel, problem: 'nested write to an intervention that mentions `status`' });
    }
  }

  if (/\$(execute|query)Raw(Unsafe)?\b[\s\S]{0,400}?\bIntervention\b/.test(text)) {
    findings.push({ file: rel, problem: 'raw SQL on the Intervention table' });
  }

  return { findings, writes };
}

function scanAll(): { findings: Finding[]; writes: number } {
  const findings: Finding[] = [];
  let writes = 0;

  for (const file of listSources(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    const result = scanSource(rel, fs.readFileSync(file, 'utf8'));
    findings.push(...result.findings);
    writes += result.writes;
  }

  return { findings, writes };
}

describe('nothing writes Intervention.status outside transitionStatus()', () => {
  it('finds the intervention writes it is supposed to check', () => {
    // Sanity check on the scanner itself: the code base has dozens of them.
    expect(scanAll().writes > 10).toBe(true);
  });

  it('no write touches the status directly', () => {
    expect(scanAll().findings.map((f) => `${f.file}: ${f.problem}`)).toEqual([]);
  });

  describe('the scanner catches the ways of writing a status', () => {
    const problems = (code: string) => scanSource('x.ts', code).findings.map((f) => f.problem);

    it('a plain write', () => {
      expect(problems(`await this.prisma.intervention.update({ where: { id }, data: { status: Status.PAID, note } });`).length).toBe(1);
    });

    it('a quoted or computed key', () => {
      expect(problems(`await prisma.intervention.update({ where: { id }, data: { 'status': 'PAID' } });`).length).toBe(1);
      expect(problems(`await prisma.intervention.update({ where: { id }, data: { ['status']: 'PAID' } });`).length).toBe(1);
    });

    it('a write nested in a condition or spread', () => {
      expect(problems(`await prisma.intervention.updateMany({ where, data: { ...(done ? { status: 'PAID' } : {}) } });`).length).toBeGreaterThan(0);
      expect(problems(`await prisma.intervention.update({ where, data: { ...dto, note } });`).length).toBe(1);
    });

    it('data from a variable, or arguments that are not a literal', () => {
      expect(problems(`await prisma.intervention.update({ where, data: payload });`).length).toBe(1);
      expect(problems(`await prisma.intervention.update(args);`).length).toBe(1);
    });

    it('an upsert, a create with a made-up status, a nested write from another model', () => {
      expect(problems(`await prisma.intervention.upsert({ where, update: { status: 'PAID' }, create: {} });`).length).toBe(1);
      expect(problems(`await prisma.intervention.create({ data: { status: Status.CREATED } });`).length).toBe(1);
      expect(problems(`await prisma.appointment.update({ where, data: { intervention: { update: { status: 'PAID' } } } });`).length).toBe(1);
    });

    it('raw SQL on the table', () => {
      expect(problems('await prisma.$executeRaw`UPDATE "Intervention" SET status = 1`;').length).toBe(1);
    });

    it('while the normal code passes', () => {
      expect(problems(`await prisma.intervention.update({ where: { id }, data: { rating: 5, note: 'x' } });`)).toEqual([]);
      expect(problems(`await prisma.intervention.create({ data: { status: initialStatus() as Status, address } });`)).toEqual([]);
      expect(problems(`// status: 'PAID' in a comment\nawait prisma.intervention.update({ where, data: { note } });`)).toEqual([]);
      expect(problems(`await prisma.intervention.update({ where, data: { lastStatusChangedAt: now, statusNote: 'x' } });`)).toEqual([]);
    });

    it('an allowed variable stops being allowed when its marker line is gone', () => {
      const rel = 'modules/interventions/interventions.service.ts';
      const withMarker = `const { artisanId, status, ...rest } = updateInterventionDto;\nawait this.prisma.intervention.update({ where: { id }, data: data as any });`;
      const withoutMarker = `await this.prisma.intervention.update({ where: { id }, data: data as any });`;

      expect(scanSource(rel, withMarker).findings).toEqual([]);
      expect(scanSource(rel, withoutMarker).findings.length).toBe(1);
    });
  });
});
