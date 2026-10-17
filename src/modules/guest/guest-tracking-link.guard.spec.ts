import { createHash } from 'crypto';

import { GuestTrackingLinkGuard } from './guest-tracking-link.guard';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

function makeGuard() {
  const lookups: any[] = [];
  const prisma: any = {
    intervention: {
      count: async ({ where }: any) => {
        lookups.push(where);

        return where.id === 4 && where.trackingToken === sha('good-token') ? 1 : 0;
      },
    },
  };

  const run = (params: any, query: any) =>
    new GuestTrackingLinkGuard(prisma).canActivate({
      switchToHttp: () => ({ getRequest: () => ({ params, query }) }),
    } as any);

  return { run, lookups };
}

async function failure(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('expected a failure');
}

describe('the tracking link is checked before an upload is read', () => {
  it('the right number with its token goes through', async () => {
    const { run } = makeGuard();

    expect(await run({ id: '4' }, { token: 'good-token' })).toBe(true);
  });

  it('a wrong token, or the token of another request, is the same 404 as everywhere', async () => {
    const { run } = makeGuard();

    for (const [params, query] of [
      [{ id: '4' }, { token: 'nope' }],
      [{ id: '5' }, { token: 'good-token' }],
    ] as const) {
      const error = await failure(run(params, query));

      expect(error.status).toBe(404);
      expect(error.message).toBe('Lien de suivi invalide ou expiré.');
    }
  });

  it('a missing or odd token, or a number that is not a number, is refused without asking the database', async () => {
    const { run, lookups } = makeGuard();

    for (const [params, query] of [
      [{ id: '4' }, {}],
      [{ id: '4' }, { token: '' }],
      [{ id: '4' }, { token: ['good-token', 'again'] }],
      [{ id: '4' }, { token: { a: 1 } }],
      [{ id: 'abc' }, { token: 'good-token' }],
      [{ id: '4.5' }, { token: 'good-token' }],
      [{ id: '0' }, { token: 'good-token' }],
      [{ id: '-3' }, { token: 'good-token' }],
      [{}, { token: 'good-token' }],
    ] as const) {
      expect((await failure(run(params, query))).status).toBe(404);
    }

    expect(lookups.length).toBe(0);
  });

  it('only the hash of the token is sent to the database', async () => {
    const { run, lookups } = makeGuard();

    await run({ id: '4' }, { token: 'good-token' });

    expect(lookups[0].trackingToken).toBe(sha('good-token'));
    expect(JSON.stringify(lookups).includes('good-token')).toBe(false);
  });
});
