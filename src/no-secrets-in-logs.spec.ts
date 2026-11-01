import * as fs from 'fs';
import * as path from 'path';

/**
 * P1-03 guard: a one-time code, a link or a message text must never reach the logs.
 *
 * A message body can be a verification code or a password link, and a logged
 * link is a password. An error raised while storing or sending a message can
 * repeat that text in its own message, so logging `error.message` is just as
 * bad: use describeError(error) (name and code only).
 *
 * This reads every source file, finds the log calls, and looks at the *code*
 * inside them: string literals are ignored (what they say is the developer's
 * own wording), but every identifier, `${...}` expression and concatenated value
 * must be on a short list of things that are safe to log (ids, counts, channel
 * and status labels, our own `reason` wording, describeError(error)). Anything
 * else fails with its name: a new log line that mentions a new variable is a
 * moment to ask "can this hold a code, a link or a message?", and if the answer
 * is no, add the name to SAFE_NAMES. It is a text scan: it stops the usual
 * mistakes, not someone determined.
 */

const SRC = path.resolve(__dirname);

/** A property that is only a count, an id or a label is safe whatever it hangs off (`message.id`, `tokens.length`). */
const SAFE_LEAVES = new Set([
  'id',
  'ids',
  'length',
  'count',
  'size',
  'channel',
  'status',
  'type',
  'attempts',
  'maxAttempts',
  'provider',
  'isConfigured',
  'workerEnabled',
]);

/** Methods that only change how a safe value is written (`status.toLowerCase()`, `names.join(', ')`). */
const SAFE_METHODS = new Set(['toLowerCase', 'toUpperCase', 'join', 'map', 'toFixed']);

/** Local names that hold our own wording, labels or numbers in the current log calls. */
const SAFE_NAMES = new Set([
  'attempt',
  'channel',
  'deleted', // how many old positions the nightly round deleted
  'heldJobs', // how many jobs in dispute kept their positions
  'historyDays', // the setting: how many days positions are kept
  'key', // a rate limit or template key
  'label',
  'name', // a placeholder or provider name
  'needed', // the placeholders a template must contain
  'port',
  'previousStatus',
  'reason', // our own wording for why a message was dropped or failed
  'stale',
  'to', // the status a request moves to
  'what',
  'describe', // local helper in OutboxService.onModuleInit
]);

/** Whole paths that are our own wording (set by this code, never by a user). */
const SAFE_PATHS = new Set(['outcome.note']);

/** Names that end like an id, a count or a duration are numbers (`userId`, `retryCount`, `waitMs`). */
const SAFE_SUFFIX = /^[a-z]\w*(Id|Ids|Count|Ms|Seconds|Index|Total)$/;

/** JavaScript words that can show up inside a log call. */
const JS_WORDS = new Set(['true', 'false', 'null', 'undefined', 'typeof', 'new', 'await', 'void', 'String', 'Number', 'Date', 'Math']);

/**
 * Putting the error itself in the log prints its message (and stack), and
 * `.message`, `.stack`, `.cause` or `.toString()` carry the same text: only
 * `.name` and `.code` may be used, which describeError(error) does for you.
 */
const ERROR_NAMES = new Set(['error', 'err', 'e', 'exception', 'cause']);

/**
 * The one reviewed exception: a developer without a provider can ask to see the
 * text of a message (DELIVERY_DEBUG_LOG=true, ignored in production). It only
 * counts while the line that switches it off is still *above* the call, close to it.
 */
const ALLOWED: Array<{ file: string; paths: string[]; marker: string }> = [
  {
    file: 'modules/notifications/delivery/outbox.service.ts',
    // the debug line shows who it goes to, the subject and the text
    paths: ['row.body', 'row.subject', 'recipient'],
    marker: 'if (!this.config.debugLogBodies) return;',
  },
];

const MARKER_DISTANCE = 400;

// ---------------------------------------------------------------------------
// A small scanner that knows about strings, template literals and comments.
// ---------------------------------------------------------------------------

function skipString(src: string, start: number): number {
  const quote = src[start];

  for (let i = start + 1; i < src.length; i++) {
    if (src[i] === '\\') i++;
    else if (src[i] === quote) return i;
  }

  return src.length;
}

/** Reads a template literal starting at the backtick; returns the code inside its `${}` and where it ends. */
function readTemplate(src: string, start: number): { code: string; end: number } {
  let code = '';

  for (let i = start + 1; i < src.length; i++) {
    const ch = src[i];

    if (ch === '\\') {
      i++;
    } else if (ch === '`') {
      return { code, end: i };
    } else if (ch === '$' && src[i + 1] === '{') {
      let depth = 0;
      let j = i + 1;

      for (; j < src.length; j++) {
        const inner = src[j];

        if (inner === '"' || inner === "'") j = skipString(src, j);
        else if (inner === '`') j = readTemplate(src, j).end;
        else if (inner === '{') depth++;
        else if (inner === '}' && --depth === 0) break;
      }

      code += ` ${codeOf(src.slice(i + 2, j))} `;
      i = j;
    }
  }

  return { code, end: src.length };
}

/** The code of an expression: string literals emptied, template text dropped, `${}` expressions kept. */
export function codeOf(src: string): string {
  let out = '';

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (ch === '"' || ch === "'") {
      i = skipString(src, i);
      out += ' ';
    } else if (ch === '`') {
      const template = readTemplate(src, i);
      out += ` ${template.code} `;
      i = template.end;
    } else {
      out += ch;
    }
  }

  return out;
}

function stripComments(src: string): string {
  let out = '';

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (ch === '"' || ch === "'") {
      const end = skipString(src, i);
      out += src.slice(i, end + 1);
      i = end;
    } else if (ch === '`') {
      const end = readTemplate(src, i).end;
      out += src.slice(i, end + 1);
      i = end;
    } else if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 1;
      out += ' ';
    } else {
      out += ch;
    }
  }

  return out;
}

function endOfCall(text: string, open: number): number {
  let depth = 0;

  for (let i = open; i < text.length; i++) {
    const ch = text[i];

    if (ch === '"' || ch === "'") i = skipString(text, i);
    else if (ch === '`') i = readTemplate(text, i).end;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }

  return text.length;
}

/** Any call on something called a logger or a log, or on console (`this.logger.warn(`, `this.auditLog.error(`, `console.dir(`). */
const CALL =
  /(?:\b[\w$]+\s*\??\.\s*)*\b(?:\w*[Ll]ogger|\w*[Ll]og|console)\s*\??\.\s*(?:log|warn|error|debug|verbose|info|fatal|dir|table|trace)\s*\(/g;

export function logCalls(source: string): Array<{ index: number; args: string }> {
  const text = stripComments(source);
  const calls: Array<{ index: number; args: string }> = [];
  let match: RegExpExecArray | null;

  CALL.lastIndex = 0;

  while ((match = CALL.exec(text))) {
    const open = match.index + match[0].length - 1;

    calls.push({ index: match.index, args: text.slice(open + 1, endOfCall(text, open)) });
  }

  return calls;
}

/** True for a path that can only be an id, a count, a label or our own wording. */
function isSafe(segments: string[]): boolean {
  if (segments.length === 1 && JS_WORDS.has(segments[0])) return true;
  if (segments[0] === 'this' && segments.length > 1 && segments.slice(1).every((part) => !part)) return true;

  // error.name / error.code only
  if (ERROR_NAMES.has(segments[0]) && segments.length === 2 && ['name', 'code'].includes(segments[1])) return true;

  let rest = segments;

  // status.toLowerCase  ->  status
  while (rest.length > 1 && SAFE_METHODS.has(rest[rest.length - 1])) {
    rest = rest.slice(0, -1);
  }

  const leaf = rest[rest.length - 1];

  if (SAFE_PATHS.has(rest.join('.'))) return true;
  if (rest.length === 1 && SAFE_METHODS.has(leaf)) return true; // `.join(` after a call
  if (SAFE_LEAVES.has(leaf) || (SAFE_NAMES.has(leaf) && rest.length === 1) || SAFE_SUFFIX.test(leaf)) return true;
  if (rest.length === 1 && JS_WORDS.has(leaf)) return true;
  if (rest.length === 2 && rest[0] === 'Date' && rest[1] === 'now') return true;
  if (rest[0] === 'Math') return true;

  return false;
}

/** Log calls whose arguments carry anything that is not on the list of safe things, or a raw error. */
export function scanSource(rel: string, source: string): string[] {
  const text = stripComments(source);
  const problems: string[] = [];

  for (const call of logCalls(source)) {
    // describeError(error) is the safe way to mention an error: name and code, no text.
    const code = codeOf(call.args).replace(/\bdescribeError\s*\(\s*[\w$.?]+\s*\)/g, ' ');
    const before = text.slice(Math.max(0, call.index - MARKER_DISTANCE), call.index);

    for (const found of code.matchAll(/[A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*)*/g)) {
      const segments = found[0].split(/\s*\??\.\s*/);
      const joined = segments.join('.');

      if (isSafe(segments)) continue;

      if (ERROR_NAMES.has(segments[0])) {
        problems.push(`${rel}: logs the error or its text (\`${joined}\`) — use describeError(${segments[0]})`);
        continue;
      }

      const allowed = ALLOWED.some(
        (rule) => rule.file === rel && rule.paths.includes(joined) && before.includes(rule.marker),
      );

      if (!allowed) {
        problems.push(`${rel}: logs \`${joined}\`, which is not on the list of safe things (SAFE_NAMES / SAFE_LEAVES)`);
      }
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------

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

describe('no log line carries a code, a link, a message text or a raw error', () => {
  it('finds every call on a logger or console that is written in the code (the scanner is not fooled by the file)', () => {
    let written = 0;
    let found = 0;

    for (const file of listSources(SRC)) {
      const source = fs.readFileSync(file, 'utf8');
      const lines = source.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));

      // deliberately broader than the scanner's own pattern: ANY method called on a logger or console
      written += (lines.join('\n').match(/\b(?:\w*[Ll]ogger|console|Logger)\s*\??\.\s*\w+\s*\(/g) ?? []).length;
      found += logCalls(source).length;
    }

    expect(written > 15).toBe(true);
    expect(found).toBe(written);
  });

  it('nothing in the code base does', () => {
    const problems: string[] = [];

    for (const file of listSources(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      problems.push(...scanSource(rel, fs.readFileSync(file, 'utf8')));
    }

    expect(problems).toEqual([]);
  });

  describe('the scanner catches the usual mistakes', () => {
    it('interpolated codes, links and bodies', () => {
      expect(scanSource('x.ts', 'this.logger.log(`code is ${otp}`);').length).toBe(1);
      expect(scanSource('x.ts', 'this.logger.log(`Body: "${content}"`);').length).toBe(1);
      expect(scanSource('x.ts', 'logger.warn(`link ${resetUrl}`);').length).toBe(1);
      expect(scanSource('x.ts', 'console.log(`token ${user.rawToken}`);').length).toBe(1);
      expect(scanSource('x.ts', 'this.logger.debug(`SMS To: ${phone} | "${message.body}"`);').length).toBe(2);
    });

    it('the other names a message text goes by, and anything not known to be safe', () => {
      for (const name of ['message', 'msg', 'sms', 'rendered', 'raw', 'recipient', 'subject', 'payload', 'dto', 'row', 'user', 'config', 'notification', 'result', 'info']) {
        expect(scanSource('x.ts', `this.logger.log(\`sent ${'$'}{${name}}\`);`).length).toBe(1);
      }
    });

    it('a secret passed as a plain argument or glued on with +', () => {
      expect(scanSource('x.ts', 'console.log(rawToken);').length).toBe(1);
      expect(scanSource('x.ts', "this.logger.log('code', otp);").length).toBe(1);
      expect(scanSource('x.ts', "this.logger.log('code ' + otp);").length).toBe(1);
      expect(scanSource('x.ts', "this.logger.log('sent ' + row.recipient);").length).toBe(1);
    });

    it('static Logger calls, whole records and serialised values', () => {
      expect(scanSource('x.ts', 'Logger.warn(`failed ${otp}`);').length).toBe(1);
      expect(scanSource('x.ts', 'this.logger.log(JSON.stringify(row));').length).toBeGreaterThan(0);
      expect(scanSource('x.ts', 'this.logger.log(row);').length).toBe(1);
    });

    it('the text of an error, and the error itself, in all the ways to get at it', () => {
      expect(scanSource('x.ts', 'this.logger.error(`failed: ${error.message}`);').length).toBe(1);
      expect(scanSource('x.ts', 'this.logger.error(`failed: ${error?.message ?? error}`);').length).toBeGreaterThan(0);
      expect(scanSource('x.ts', 'this.logger.error(error);').length).toBe(1);
      expect(scanSource('x.ts', 'this.logger.error(`failed: ${err}`);').length).toBe(1);
      expect(scanSource('x.ts', "this.logger.error('failed', error.stack);").length).toBe(1);
      expect(scanSource('x.ts', 'this.logger.error(`failed: ${error.toString()}`);').length).toBeGreaterThan(0);
      expect(scanSource('x.ts', 'this.logger.error(`failed: ${e.cause}`);').length).toBe(1);
      // what is allowed: the kind of error
      expect(scanSource('x.ts', 'this.logger.error(`failed (${describeError(error)})`);').length).toBe(0);
      expect(scanSource('x.ts', 'this.logger.error(`failed (${error.name} ${error?.code})`);').length).toBe(0);
    });

    it('a message built first and logged afterwards cannot hide a secret', () => {
      expect(scanSource('x.ts', 'const line = `code ${otp}`; this.logger.log(line);').length).toBe(1);
      expect(scanSource('x.ts', 'this.logger.log(user);').length).toBe(1);
      expect(scanSource('x.ts', 'this.logger.log(this.config);').length).toBeGreaterThan(0);
    });

    it('every way of calling a logger counts', () => {
      for (const call of ['this.log.warn(otp)', 'this.auditLogger.error(otp)', 'console.dir(otp)', 'console.table(otp)', 'console.trace(otp)', 'Logger.verbose(otp)', 'this.logger?.warn(otp)']) {
        expect(scanSource('x.ts', `${call};`).length).toBe(1);
      }
    });

    it('a call that is hard to read cannot hide one: strings with brackets, nested templates', () => {
      expect(scanSource('x.ts', "this.logger.log('a ) b (', otp);").length).toBe(1);
      expect(scanSource('x.ts', 'this.logger.log(`a ${[1].map((x) => `${otp}`).join()}`);').length).toBeGreaterThan(0);
      expect(scanSource('x.ts', "const url = 'http://x.tn'; this.logger.log(otp);").length).toBe(1);
    });

    it('the reviewed exception stops being one when its safety line is gone or not above it', () => {
      const rel = 'modules/notifications/delivery/outbox.service.ts';
      const line = 'this.logger.log(`[DEBUG] ${row.body}`);';
      const marker = 'if (!this.config.debugLogBodies) return;';

      expect(scanSource(rel, `${marker}\n${line}`)).toEqual([]);
      expect(scanSource(rel, line).length).toBe(1);
      expect(scanSource(rel, `${line}\n${marker}`).length).toBe(1); // below the call: does not protect it
      expect(scanSource(rel, `${marker}\n${'\n'.repeat(500)}${line}`).length).toBe(1); // far above: not this call
      expect(scanSource(rel, `// ${marker}\n${line}`).length).toBe(1); // a comment is not a guard
      expect(scanSource('modules/other.ts', `${marker}\n${line}`).length).toBe(1);
    });

    it('while ordinary log lines pass', () => {
      expect(scanSource('x.ts', 'this.logger.log(`Outbox #${row.id} ${row.channel}: sent via ${outcome.provider}`);').length).toBe(0);
      expect(scanSource('x.ts', 'this.logger.warn(`#${userId} waited ${waitMs} ms, ${needed.join(", ")}`);').length).toBe(0);
      expect(scanSource('x.ts', 'this.logger.warn(`${previousStatus} -> ${to}: ${reason}`);').length).toBe(0);
      expect(scanSource('x.ts', 'this.logger.error(`Notification failed (${describeError(error)})`);').length).toBe(0);
      expect(scanSource('x.ts', 'this.logger.warn(`${tokens.length} devices, message #${message.id}`);').length).toBe(0);
      expect(scanSource('x.ts', "this.logger.warn('SMS is not configured: the code is not sent');").length).toBe(0);
      expect(scanSource('x.ts', '// this.logger.log(`code ${otp}`);').length).toBe(0);
      expect(scanSource('x.ts', '/* this.logger.log(otp); */').length).toBe(0);
    });
  });
});
