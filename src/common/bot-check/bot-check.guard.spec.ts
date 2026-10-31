import { BadRequestException, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

import { BotCheckGuard } from './bot-check.guard';
import { BotCheckService } from './bot-check.service';
import { BotChecker, leadingZeroBits, solutionDigest } from './bot-check';

function solve(challenge: string, bits: number): string {
  for (let n = 0; ; n++) {
    if (leadingZeroBits(solutionDigest(challenge, n.toString(36))) >= bits) return n.toString(36);
  }
}

function makeGuard(enabled = true) {
  const clock = { now: 1_800_000_000_000 };
  const checker = new BotChecker({
    config: { enabled, bits: 8, minAgeMs: 3000, maxAgeMs: 30 * 60_000 },
    secret: () => Buffer.from('k'.repeat(32)),
    now: () => clock.now,
  });
  const service = { issue: (p?: string) => checker.issue(p), verify: (i: any, p?: string) => checker.verify(i, p) } as unknown as BotCheckService;

  return { clock, checker, guard: new BotCheckGuard(service) };
}

const contextOf = (body: unknown) => ({ switchToHttp: () => ({ getRequest: () => ({ body }) }) }) as any;

function refusal(run: () => unknown): any {
  try {
    run();
  } catch (error) {
    return error;
  }

  throw new Error('expected a refusal');
}

describe('BotCheckGuard', () => {
  it('lets a request through with a solved challenge', () => {
    const { guard, checker, clock } = makeGuard();
    const challenge = (checker.issue() as any).challenge as string;

    clock.now += 4000;

    expect(guard.canActivate(contextOf({ botChallenge: challenge, botSolution: solve(challenge, 8), website: '' }))).toBe(true);
  });

  it('refuses a request without the check, with a 400 that carries a code and one message', () => {
    const { guard } = makeGuard();
    const error = refusal(() => guard.canActivate(contextOf({ description: 'Fuite' })));

    expect(error instanceof BadRequestException).toBe(true);
    expect(error.getStatus()).toBe(400);
    expect(error.getResponse().code).toBe('BOT_CHECK_FAILED');
    expect(error.getResponse().message).toBe('La vérification de sécurité a échoué. Rechargez la page et réessayez.');
  });

  it('gives the same answer whatever the reason', () => {
    const { guard, checker, clock } = makeGuard();
    const challenge = (checker.issue() as any).challenge as string;
    const answers = new Set<string>();

    for (const body of [
      {},
      undefined,
      null,
      'text',
      { botChallenge: challenge, botSolution: solve(challenge, 8) }, // too early
      { botChallenge: challenge, botSolution: 'nope', website: 'x' },
      { botChallenge: 'junk', botSolution: '1' },
    ]) {
      answers.add(JSON.stringify(refusal(() => guard.canActivate(contextOf(body))).getResponse()));
    }

    expect(answers.size).toBe(1);
    clock.now += 0;
  });

  it('writes the reason to the log, once, and never the challenge or the solution', () => {
    const lines: string[] = [];
    const original = Logger.prototype.warn;

    Logger.prototype.warn = function (message: unknown) {
      lines.push(String(message));
    } as typeof Logger.prototype.warn;

    try {
      const { guard, checker, clock } = makeGuard();
      const challenge = (checker.issue() as any).challenge as string;

      clock.now += 4000;
      refusal(() => guard.canActivate(contextOf({ botChallenge: challenge, botSolution: 'nope', website: 'x' })));
      refusal(() => guard.canActivate(contextOf({})));

      expect(lines.length).toBe(2);
      expect(lines[0]).toContain('honeypot');
      expect(lines[1]).toContain('missing');
      expect(lines.every((line) => !line.includes(challenge) && !line.includes('nope'))).toBe(true);
    } finally {
      Logger.prototype.warn = original;
    }
  });

  it('reads the hidden field from the body', () => {
    const { guard, checker, clock } = makeGuard();
    const challenge = (checker.issue() as any).challenge as string;

    clock.now += 4000;

    const error = refusal(() =>
      guard.canActivate(contextOf({ botChallenge: challenge, botSolution: solve(challenge, 8), website: 'https://spam.example' })),
    );

    expect(error.getResponse().code).toBe('BOT_CHECK_FAILED');
  });

  it('lets everything through when the check is off', () => {
    const { guard } = makeGuard(false);

    expect(guard.canActivate(contextOf({}))).toBe(true);
    expect(guard.canActivate(contextOf(undefined))).toBe(true);
  });
});

/** Runs `body` with these variables, and puts the environment back whatever happens. */
function withEnv(variables: Record<string, string | undefined>, body: () => void) {
  const saved = { ...process.env };

  try {
    for (const [name, value] of Object.entries(variables)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }

    body();
  } finally {
    process.env = saved;
  }
}

describe('BotCheckService (read from the environment)', () => {
  it('is off when BOT_CHECK says so, and never needs the secret then', () => {
    withEnv({ BOT_CHECK: 'off', JWT_ACCESS_SECRET: undefined, BOT_CHECK_SECRET: undefined }, () => {
      const service = new BotCheckService();

      expect(service.config.enabled).toBe(false);
      expect(service.issue()).toEqual({ enabled: false });
      expect(service.verify({})).toEqual({ ok: true });
    });
  });

  it('signs with a key derived from the access secret when it has none of its own', () => {
    let challenge: any;
    const reasonOf = (service: BotCheckService) =>
      (service.verify({ challenge: challenge.challenge, solution: solve(challenge.challenge, 8) }) as any).reason;

    withEnv({ BOT_CHECK: 'on', BOT_CHECK_BITS: '8', JWT_ACCESS_SECRET: 'a'.repeat(40), BOT_CHECK_SECRET: undefined }, () => {
      const service = new BotCheckService();

      challenge = service.issue();

      expect(challenge.enabled).toBe(true);
      expect(challenge.bits).toBe(8);
      // Not old enough yet: the signature and the solution are fine, the age is not.
      expect(reasonOf(service)).toBe('too-early');
      // Another process with the same secret reads the same challenge.
      expect(reasonOf(new BotCheckService())).toBe('too-early');
    });

    withEnv({ BOT_CHECK: 'on', BOT_CHECK_BITS: '8', JWT_ACCESS_SECRET: 'b'.repeat(40), BOT_CHECK_SECRET: undefined }, () => {
      expect(reasonOf(new BotCheckService())).toBe('signature');
    });

    // A key of its own wins over the access secret.
    withEnv({ BOT_CHECK: 'on', BOT_CHECK_BITS: '8', JWT_ACCESS_SECRET: 'a'.repeat(40), BOT_CHECK_SECRET: 'own-key' }, () => {
      expect(reasonOf(new BotCheckService())).toBe('signature');
    });
  });
});

/**
 * Nothing in a unit test goes through Nest's decorators, so these read the two controllers for the
 * lines that decide which routes are checked, and in which order.
 */
const read = (relative: string) => fs.readFileSync(path.join(__dirname, '../../modules', relative), 'utf8');

/** A route as written: the decorators above its line, the ones below it, and the signature of the method. */
function decoratorsOf(source: string, routeLine: string): string {
  const at = source.indexOf(routeLine);

  expect(at).toBeGreaterThan(0);

  const end = source.indexOf(') {\n', at);

  expect(end).toBeGreaterThan(at);

  return source.slice(source.lastIndexOf('}\n', at), end);
}

describe('which routes are checked (P1-16)', () => {
  const guest = read('guest/guest.controller.ts');
  const legacy = read('interventions/interventions.controller.ts');

  it('POST /guest/interventions: the limit first, then the check', () => {
    const route = decoratorsOf(guest, "@Post('interventions')");

    expect(route).toContain('@UseGuards(RateLimitGuard, BotCheckGuard)');
    expect(route).toContain("@RateLimit({ name: 'guest-create'");
  });

  it('the interventions controller takes no bot check: the public POST /interventions that did was deleted (P3-03), /guest/interventions is the one public form', () => {
    expect(legacy).not.toContain('BotCheckGuard');
    expect(legacy).not.toContain("@Post()\n");
    expect(read('interventions/interventions.module.ts')).not.toContain('BotCheckModule');
  });

  it('the signed-in route has no bot check (a person with an account is known)', () => {
    const route = decoratorsOf(legacy, "@Post('secure')");

    expect(route).toContain("@UseGuards(AuthGuard('jwt'), RateLimitGuard)");
    expect(route).not.toContain('BotCheckGuard');
  });

  it('no other guest route takes the check: they are behind the tracking link', () => {
    expect(guest.match(/BotCheckGuard\)/g)).toHaveLength(1);
  });

  it('GET /guest/challenge is limited by address and gives what the service issues', () => {
    const route = decoratorsOf(guest, "@Get('challenge')");

    expect(route).toContain('@UseGuards(RateLimitGuard)');
    expect(route).toContain("@RateLimit({ name: 'guest-challenge', limit: 240, windowMs: 60 * 60_000 })");
    expect(guest).toContain('challenge() {\n    return this.botCheck.issue();\n  }');
  });

  it('a puzzle is never kept by a cache between two people', () => {
    expect(decoratorsOf(guest, "@Get('challenge')")).toContain("@Header('Cache-Control', 'no-store')");
    expect(guest).toContain('  Header,\n');
  });

  it('the two request forms accept the three fields, and the create of the dashboard (POST /interventions/secure) does not store them', () => {
    expect(read('guest/dto/create-guest-intervention.dto.ts')).toContain('export class CreateGuestInterventionDto extends BotCheckFields');
    expect(read('interventions/dto/create-intervention.dto.ts')).toContain('export class CreateInterventionDto extends BotCheckFields');

    const service = read('interventions/interventions.service.ts');

    for (const field of ['botChallenge: _botChallenge', 'botSolution: _botSolution', 'website: _website']) {
      expect(service).toContain(field);
    }
  });
});
