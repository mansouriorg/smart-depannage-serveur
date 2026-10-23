import * as fs from 'fs';
import * as path from 'path';

/**
 * Helpers for the specs that read the source code to keep a rule from being
 * broken by accident (a text scan, not a type check). Test support only: nothing
 * in the application imports it.
 */

export const SRC_ROOT = path.resolve(__dirname, '../..');

/** The folder of the test support (this file, the in-memory database, the scenarios): code that tests use and the application never loads. */
const TESTING_DIR = path.join(SRC_ROOT, 'common', 'testing');

/**
 * Every non-spec .ts file under `dir`, as a path relative to src, with forward slashes. The test support
 * (`common/testing`) is not part of the application and is left out: the rules these scans keep (who writes a
 * column, who takes a lock, how a link is built) are rules for the application's code, and the scenarios have to
 * name those columns and links to check them.
 */
export function listSourceFiles(dir: string = SRC_ROOT): string[] {
  const out: string[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (full === TESTING_DIR) continue;

      out.push(...listSourceFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      out.push(path.relative(SRC_ROOT, full).split(path.sep).join('/'));
    }
  }

  return out.sort();
}

export function readSource(rel: string): string {
  return fs.readFileSync(path.join(SRC_ROOT, rel), 'utf8');
}

export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Text between the bracket at `open` and its matching close (exclusive). */
export function balanced(text: string, open: number): string {
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

/** The value of `key:` at depth 0 of an object literal body: literal text or expression. */
export function valueOfKey(body: string, key: string): { literal: boolean; text: string } | null {
  let depth = 0;

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];

    if ('({['.includes(ch)) depth++;
    if (')}]'.includes(ch)) depth--;

    if (depth !== 0) continue;

    const match = new RegExp(`^${key}\\s*:\\s*`).exec(body.slice(i));
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
