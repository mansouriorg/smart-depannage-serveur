import {
  BOT_CHECK_MAX_AGE_MS,
  BOT_CHECK_MIN_AGE_MS,
  BotChecker,
  botCheckConfigProblems,
  botCheckSecret,
  leadingZeroBits,
  readBotCheckConfig,
  solutionDigest,
} from './bot-check';

const SECRET = Buffer.from('s'.repeat(32));

function world(overrides: { bits?: number; enabled?: boolean; secret?: Buffer; maxRemembered?: number } = {}) {
  const clock = { now: 1_800_000_000_000 };
  let counter = 0;

  const make = (extra: { bits?: number; secret?: Buffer } = {}) =>
    new BotChecker({
      config: {
        enabled: overrides.enabled ?? true,
        bits: extra.bits ?? overrides.bits ?? 8,
        minAgeMs: BOT_CHECK_MIN_AGE_MS,
        maxAgeMs: BOT_CHECK_MAX_AGE_MS,
      },
      secret: () => extra.secret ?? overrides.secret ?? SECRET,
      now: () => clock.now,
      randomId: () => (counter++).toString(16).padStart(24, '0'),
      maxRemembered: overrides.maxRemembered,
    });

  return { clock, make, checker: make() };
}

/** What the page does: look for the number whose hash starts with enough zero bits. */
function solve(challenge: string, bits: number): string {
  for (let n = 0; ; n++) {
    const candidate = n.toString(36);

    if (leadingZeroBits(solutionDigest(challenge, candidate)) >= bits) return candidate;
  }
}

function issued(w: ReturnType<typeof world>) {
  const challenge = w.checker.issue() as any;

  return { challenge: challenge.challenge as string, solution: solve(challenge.challenge, challenge.bits) };
}

const reason = (verdict: any) => (verdict.ok ? 'ok' : verdict.reason);

describe('readBotCheckConfig', () => {
  it('is on with 16 bits when nothing is set', () => {
    const config = readBotCheckConfig({});

    expect(config.enabled).toBe(true);
    expect(config.bits).toBe(16);
    expect(config.minAgeMs).toBe(3000);
    expect(config.maxAgeMs).toBe(30 * 60_000);
  });

  it('is off for off, false, 0 and no, in any case', () => {
    for (const value of ['off', 'OFF', 'false', '0', 'no', ' off ']) {
      expect(readBotCheckConfig({ BOT_CHECK: value }).enabled).toBe(false);
    }

    for (const value of ['on', 'true', '1', 'yes', '']) {
      expect(readBotCheckConfig({ BOT_CHECK: value }).enabled).toBe(true);
    }
  });

  it('reads the difficulty from 8 to 24 and ignores anything else', () => {
    expect(readBotCheckConfig({ BOT_CHECK_BITS: '20' }).bits).toBe(20);
    expect(readBotCheckConfig({ BOT_CHECK_BITS: '8' }).bits).toBe(8);
    expect(readBotCheckConfig({ BOT_CHECK_BITS: '24' }).bits).toBe(24);

    for (const value of ['7', '25', '12.5', 'abc', '-3', '']) {
      expect(readBotCheckConfig({ BOT_CHECK_BITS: value }).bits).toBe(16);
    }
  });
});

describe('botCheckConfigProblems', () => {
  it('has nothing to say about unset or right values', () => {
    expect(botCheckConfigProblems({})).toEqual([]);
    expect(botCheckConfigProblems({ BOT_CHECK: 'off', BOT_CHECK_BITS: '12' })).toEqual([]);
  });

  it('names a mode that is neither on nor off, and a difficulty out of range', () => {
    expect(botCheckConfigProblems({ BOT_CHECK: 'maybe' }).length).toBe(1);
    expect(botCheckConfigProblems({ BOT_CHECK_BITS: '3' }).length).toBe(1);
    expect(botCheckConfigProblems({ BOT_CHECK_BITS: 'lots' }).length).toBe(1);
    expect(botCheckConfigProblems({ BOT_CHECK: 'maybe', BOT_CHECK_BITS: '99' }).length).toBe(2);
  });
});

describe('botCheckSecret', () => {
  it('uses its own value when there is one', () => {
    expect(botCheckSecret({ BOT_CHECK_SECRET: ' mine ' }, () => 'unused').toString('utf8')).toBe('mine');
  });

  it('derives one from the access-token secret otherwise, never the secret itself', () => {
    const derived = botCheckSecret({}, () => 'access-secret');

    expect(derived.length).toBe(32);
    expect(derived.toString('utf8')).not.toBe('access-secret');
    expect(derived.equals(botCheckSecret({}, () => 'access-secret'))).toBe(true);
    expect(derived.equals(botCheckSecret({}, () => 'another-secret'))).toBe(false);
  });

  it('does not ask for the access secret when it has its own', () => {
    let asked = false;

    botCheckSecret({ BOT_CHECK_SECRET: 'mine' }, () => {
      asked = true;
      return 'x';
    });

    expect(asked).toBe(false);
  });
});

describe('leadingZeroBits', () => {
  it('counts the zero bits a digest starts with', () => {
    expect(leadingZeroBits(Uint8Array.from([0x80]))).toBe(0);
    expect(leadingZeroBits(Uint8Array.from([0x40]))).toBe(1);
    expect(leadingZeroBits(Uint8Array.from([0x01]))).toBe(7);
    expect(leadingZeroBits(Uint8Array.from([0x00, 0x80]))).toBe(8);
    expect(leadingZeroBits(Uint8Array.from([0x00, 0x00, 0x10]))).toBe(19);
    expect(leadingZeroBits(Uint8Array.from([0x00, 0x00, 0x00]))).toBe(24);
    expect(leadingZeroBits(Uint8Array.from([]))).toBe(0);
  });

  it('counts only the zeros before the first bit that is set, whatever follows', () => {
    expect(leadingZeroBits(Uint8Array.from([0x01, 0x00, 0x00]))).toBe(7);
    expect(leadingZeroBits(Uint8Array.from([0x00, 0x0f, 0x00]))).toBe(12);
    expect(leadingZeroBits(Uint8Array.from([0x00, 0x00, 0xff, 0x00]))).toBe(16);
  });
});

describe('solutionDigest', () => {
  it('is the SHA-256 of the challenge, a colon and the number', () => {
    // sha256("abc:1") computed outside this code.
    expect(solutionDigest('abc', '1').toString('hex')).toBe(
      require('crypto').createHash('sha256').update('abc:1').digest('hex'),
    );
    expect(solutionDigest('abc', '1').toString('hex')).not.toBe(solutionDigest('abc', '2').toString('hex'));
    expect(solutionDigest('abc', '1').toString('hex')).not.toBe(solutionDigest('abd', '1').toString('hex'));
  });
});

describe('BotChecker.issue', () => {
  it('says nothing is needed when the check is off', () => {
    expect(world({ enabled: false }).checker.issue()).toEqual({ enabled: false });
  });

  it('gives a signed challenge with its difficulty, the wait and the lifetime', () => {
    const w = world({ bits: 12 });
    const challenge = w.checker.issue() as any;

    expect(challenge.enabled).toBe(true);
    expect(challenge.bits).toBe(12);
    expect(challenge.waitMs).toBe(3000);
    expect(challenge.expiresInMs).toBe(30 * 60_000);
    expect(challenge.challenge.startsWith(`v1.${'0'.repeat(24)}.${w.clock.now}.12.guest-create.`)).toBe(true);
    expect(challenge.challenge.length).toBeLessThan(200);
  });

  it('gives a different challenge each time', () => {
    const w = world();

    expect((w.checker.issue() as any).challenge).not.toBe((w.checker.issue() as any).challenge);
  });
});

describe('BotChecker.verify', () => {
  it('lets everything through when the check is off', () => {
    const w = world({ enabled: false });

    expect(w.checker.verify({})).toEqual({ ok: true });
    expect(w.checker.verify({ honeypot: 'http://spam' })).toEqual({ ok: true });
  });

  it('accepts a solved challenge once it is old enough', () => {
    const w = world();
    const { challenge, solution } = issued(w);

    w.clock.now += 5000;

    expect(w.checker.verify({ challenge, solution, honeypot: '' })).toEqual({ ok: true });
  });

  it('accepts a challenge with a hidden field that was never sent', () => {
    const w = world();
    const { challenge, solution } = issued(w);

    w.clock.now += 5000;

    expect(reason(w.checker.verify({ challenge, solution }))).toBe('ok');
  });

  it('refuses a challenge used in its first seconds, and accepts it at 3 seconds', () => {
    const w = world();
    const { challenge, solution } = issued(w);

    w.clock.now += 2999;
    expect(reason(w.checker.verify({ challenge, solution }))).toBe('too-early');

    w.clock.now += 1;
    expect(reason(w.checker.verify({ challenge, solution }))).toBe('ok');
  });

  it('refuses a challenge older than half an hour, and accepts it at the limit', () => {
    const w = world();
    const { challenge, solution } = issued(w);

    w.clock.now += BOT_CHECK_MAX_AGE_MS;
    expect(reason(w.checker.verify({ challenge, solution }))).toBe('ok');

    const later = issued(w);

    w.clock.now += BOT_CHECK_MAX_AGE_MS + 1;
    expect(reason(w.checker.verify(later))).toBe('expired');
  });

  it('refuses a hidden field with anything in it, even a space, and even with a good solution', () => {
    const w = world();
    const { challenge, solution } = issued(w);

    w.clock.now += 5000;

    for (const honeypot of ['x', ' ', 'https://spam.example', 0, false, {}]) {
      expect(reason(w.checker.verify({ challenge, solution, honeypot }))).toBe('honeypot');
    }

    // The refusal did not use the challenge up.
    expect(reason(w.checker.verify({ challenge, solution }))).toBe('ok');
  });

  it('refuses a request with no challenge or no solution', () => {
    const w = world();
    const { challenge, solution } = issued(w);

    w.clock.now += 5000;

    expect(reason(w.checker.verify({}))).toBe('missing');
    expect(reason(w.checker.verify({ challenge }))).toBe('missing');
    expect(reason(w.checker.verify({ solution }))).toBe('missing');
    expect(reason(w.checker.verify({ challenge: 12, solution }))).toBe('missing');
    expect(reason(w.checker.verify({ challenge, solution: 5 }))).toBe('missing');
    expect(reason(w.checker.verify({ challenge: null, solution: null }))).toBe('missing');
  });

  it('refuses text that is not a challenge, and a solution that is not plain letters and digits', () => {
    const w = world();
    const { challenge, solution } = issued(w);

    w.clock.now += 5000;

    expect(reason(w.checker.verify({ challenge: 'hello', solution }))).toBe('malformed');
    expect(reason(w.checker.verify({ challenge: '', solution }))).toBe('malformed');
    expect(reason(w.checker.verify({ challenge: `${challenge}.extra`, solution }))).toBe('malformed');
    expect(reason(w.checker.verify({ challenge: `x${challenge}`, solution }))).toBe('malformed');
    expect(reason(w.checker.verify({ challenge, solution: '' }))).toBe('malformed');
    expect(reason(w.checker.verify({ challenge, solution: `${solution} ` }))).toBe('malformed');
    expect(reason(w.checker.verify({ challenge, solution: 'a'.repeat(25) }))).toBe('malformed');
    expect(reason(w.checker.verify({ challenge, solution: 'é' }))).toBe('malformed');
  });

  it('refuses a challenge that was changed: the difficulty, the date, the id', () => {
    const w = world({ bits: 12 });
    const { challenge } = issued(w);
    const parts = challenge.split('.');

    w.clock.now += 5000;

    const easier = [...parts];
    easier[3] = '8';
    const older = [...parts];
    older[2] = String(Number(parts[2]) - 600_000);
    const other = [...parts];
    other[1] = 'f'.repeat(24);

    for (const changed of [easier, older, other]) {
      const text = changed.join('.');

      expect(reason(w.checker.verify({ challenge: text, solution: solve(text, 8) }))).toBe('signature');
    }
  });

  it('refuses a challenge signed with another key', () => {
    const w = world();
    const other = w.make({ secret: Buffer.from('z'.repeat(32)) });
    const challenge = (other.issue() as any).challenge as string;

    w.clock.now += 5000;

    expect(reason(w.checker.verify({ challenge, solution: solve(challenge, 8) }))).toBe('signature');
  });

  it('refuses a challenge issued for another purpose', () => {
    const w = world();
    const challenge = (w.checker.issue('guest-other') as any).challenge as string;

    w.clock.now += 5000;

    expect(reason(w.checker.verify({ challenge, solution: solve(challenge, 8) }))).toBe('purpose');
    expect(reason(w.checker.verify({ challenge, solution: solve(challenge, 8) }, 'guest-other'))).toBe('ok');
  });

  it('refuses a wrong solution, and a wrong try does not use the challenge up', () => {
    const w = world({ bits: 16 });
    const challenge = (w.checker.issue() as any).challenge as string;
    let wrong = 'zzzz';

    // A number that does not work for this challenge.
    for (let n = 0; leadingZeroBits(solutionDigest(challenge, wrong)) >= 16; n++) wrong = `q${n}`;

    w.clock.now += 5000;

    expect(reason(w.checker.verify({ challenge, solution: wrong }))).toBe('wrong-solution');
    expect(w.checker.remembered).toBe(0);
    expect(reason(w.checker.verify({ challenge, solution: solve(challenge, 16) }))).toBe('ok');
  });

  it('wants as many zero bits as the challenge says', () => {
    const w = world({ bits: 8 });
    const challenge = (w.checker.issue() as any).challenge as string;

    // A number good for 8 bits but not for the 16 the challenge would need is not enough for a 16-bit one.
    const harder = world({ bits: 16 });
    const hard = (harder.checker.issue() as any).challenge as string;
    let almost = '';

    for (let n = 0; ; n++) {
      const candidate = n.toString(36);
      const zeros = leadingZeroBits(solutionDigest(hard, candidate));

      if (zeros >= 8 && zeros < 16) {
        almost = candidate;
        break;
      }
    }

    harder.clock.now += 5000;
    w.clock.now += 5000;

    expect(reason(harder.checker.verify({ challenge: hard, solution: almost }))).toBe('wrong-solution');
    expect(reason(w.checker.verify({ challenge, solution: solve(challenge, 8) }))).toBe('ok');
  });

  it('refuses a challenge issued before the difficulty was raised', () => {
    const w = world({ bits: 8 });
    const { challenge, solution } = issued(w);
    const raised = w.make({ bits: 12 });

    w.clock.now += 5000;

    expect(reason(raised.verify({ challenge, solution }))).toBe('easy');
    expect(reason(w.checker.verify({ challenge, solution }))).toBe('ok');
  });

  it('accepts a challenge issued with more bits than the check asks for now', () => {
    const w = world({ bits: 12 });
    const { challenge, solution } = issued(w);
    const lowered = w.make({ bits: 8 });

    w.clock.now += 5000;

    expect(reason(lowered.verify({ challenge, solution }))).toBe('ok');
  });

  it('still wants the zero bits the challenge was signed with when the check was made easier since', () => {
    const w = world({ bits: 12 });
    const challenge = (w.checker.issue() as any).challenge as string;
    const easier = w.make({ bits: 8 });
    let almost = '';

    for (let n = 0; ; n++) {
      const candidate = n.toString(36);
      const zeros = leadingZeroBits(solutionDigest(challenge, candidate));

      if (zeros >= 8 && zeros < 12) {
        almost = candidate;
        break;
      }
    }

    w.clock.now += 5000;

    expect(reason(easier.verify({ challenge, solution: almost }))).toBe('wrong-solution');
    expect(reason(easier.verify({ challenge, solution: solve(challenge, 12) }))).toBe('ok');
  });

  it('accepts a challenge once only', () => {
    const w = world();
    const { challenge, solution } = issued(w);

    w.clock.now += 5000;

    expect(reason(w.checker.verify({ challenge, solution }))).toBe('ok');
    expect(reason(w.checker.verify({ challenge, solution }))).toBe('reused');

    // Another number that also solves it does not make it new.
    let other = '';

    for (let n = 0; ; n++) {
      other = `k${n.toString(36)}`;
      if (other !== solution && leadingZeroBits(solutionDigest(challenge, other)) >= 8) break;
    }

    expect(reason(w.checker.verify({ challenge, solution: other }))).toBe('reused');
  });

  it('keeps two challenges apart', () => {
    const w = world();
    const first = issued(w);
    const second = issued(w);

    w.clock.now += 5000;

    expect(reason(w.checker.verify(first))).toBe('ok');
    expect(reason(w.checker.verify(second))).toBe('ok');
  });

  it('remembers a used challenge only while it could still be used', () => {
    const w = world();

    for (let i = 0; i < 1001; i++) {
      const { challenge, solution } = issued(w);

      w.clock.now += 3000;
      expect(reason(w.checker.verify({ challenge, solution }))).toBe('ok');
      w.clock.now -= 2999;
    }

    expect(w.checker.remembered).toBe(1001);

    // Everything remembered has expired; the next solved challenge sweeps them.
    w.clock.now += BOT_CHECK_MAX_AGE_MS + 5000;

    const fresh = issued(w);

    w.clock.now += 5000;
    expect(reason(w.checker.verify(fresh))).toBe('ok');
    expect(w.checker.remembered).toBe(1);
  });

  it('forgets the oldest when too many are remembered', () => {
    const w = world({ maxRemembered: 2 });
    const solved = [issued(w), issued(w), issued(w)];

    w.clock.now += 5000;

    for (const one of solved) expect(reason(w.checker.verify(one))).toBe('ok');

    expect(w.checker.remembered).toBe(2);
    // The newest is still remembered...
    expect(reason(w.checker.verify(solved[2]))).toBe('reused');
    // ...the oldest was forgotten (the limit is a trade: memory against a replay of the oldest).
    expect(reason(w.checker.verify(solved[0]))).toBe('ok');
  });
});
