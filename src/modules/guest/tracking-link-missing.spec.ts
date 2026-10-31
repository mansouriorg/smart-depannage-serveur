import { createHash } from 'crypto';
import { NotFoundException } from '@nestjs/common';

import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { GuestService } from './guest.service';

/**
 * A tracking route called with no link at all (P1-17). `@Query('token')` is not validated, so the value can be
 * undefined; it used to reach the hash function and end in a server error. It is the same answer as for a link that
 * is wrong: not found, and the lookup is made with the hash of an empty link, which no job has.
 */
const EMPTY_HASH = createHash('sha256').update('').digest('hex');

function guestWorld() {
  const looked: any[] = [];
  const prisma: any = {
    intervention: {
      findFirst: async ({ where }: any) => {
        looked.push(where);

        return null;
      },
    },
  };

  return { service: new GuestService(prisma, {} as any, {} as any, new RateLimitService(), {} as any, {} as any, {} as any), looked };
}

describe('a guest route called with no link (P1-17)', () => {
  it('tracking: not found, looked up as an empty link', async () => {
    const { service, looked } = guestWorld();

    await expect(service.track(1, undefined as any)).rejects.toBeInstanceOf(NotFoundException);
    expect(looked[0].trackingToken).toBe(EMPTY_HASH);
  });

  it('the quotes: not found', async () => {
    const { service } = guestWorld();

    await expect(service.getQuotes(1, undefined as any)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('accepting a quote: not found, and nothing is written', async () => {
    const { service } = guestWorld();

    await expect(service.acceptQuote(1, 2, undefined as any, {} as any)).rejects.toBeInstanceOf(NotFoundException);
  });
});
