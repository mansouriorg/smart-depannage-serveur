import { createHash } from 'crypto';
import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { leakedTo, poisonedJob } from '../../common/testing/poison';
import { InterventionWorkflowService } from './intervention-workflow.service';

/**
 * P1-08: the timeline of a job. The back office reads every line, with the author and the notes it
 * wrote for itself; the customer, the artisan and the visitor with the link read the lines meant for them.
 */
function makeWorld(options: { jobExists?: boolean } = {}) {
  const prisma: any = {
    intervention: {
      findUnique: async ({ select }: any) =>
        options.jobExists === false
          ? null
          : select
            ? { ...poisonedJob(), trackingToken: createHash('sha256').update('raw').digest('hex') }
            : poisonedJob(),
    },
    interventionEvent: { findMany: async () => poisonedJob().events },
    user: { findMany: async () => [{ id: 5, name: 'Support', email: 'support@x.tn', role: 'SUPPORT' }, { id: 20, name: 'Ali', email: 'ali@x.tn', role: 'ARTISAN' }] },
  };

  return new InterventionWorkflowService(prisma);
}

describe('the timeline of a job (P1-08)', () => {
  it('the customer and the artisan read the lines meant for them: a title, a message, a date', async () => {
    for (const user of [{ id: 10, role: 'CLIENT' }, { id: 20, role: 'ARTISAN' }]) {
      const answer: any = await makeWorld().getTimeline(user as any, 1);

      expect(leakedTo(answer, user.role === 'CLIENT' ? 'client' : 'artisan')).toEqual([]);
      expect(answer.timeline.map((event: any) => event.id)).toEqual([1]);
      expect(Object.keys(answer.timeline[0]).sort()).toEqual(['createdAt', 'id', 'interventionId', 'message', 'title', 'type']);
    }
  });

  it('the back office reads every line, with the notes it wrote for itself and who wrote what', async () => {
    const answer: any = await makeWorld().getTimeline({ id: 5, role: 'SUPPORT' } as any, 1);

    expect(answer.timeline.map((event: any) => event.id)).toEqual([1, 2, 3, 4]);
    expect(answer.timeline[1].message).toBe('SECRET<event.internalNote.message>');
    expect(answer.timeline[1].createdBy).toBeDefined();
  });

  it('somebody who is nobody on this job reads nothing', async () => {
    await expect(makeWorld().getTimeline({ id: 99, role: 'CLIENT' } as any, 1)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('the visitor with the link reads the lines meant for the customer', async () => {
    const answer: any = await makeWorld().getPublicTimeline(1, 'raw');

    expect(leakedTo(answer, 'tracking')).toEqual([]);
    expect(answer.timeline.map((event: any) => event.id)).toEqual([1]);
    expect(answer.intervention).not.toHaveProperty('trackingToken');
  });

  it('a wrong link reads nothing', async () => {
    await expect(makeWorld().getPublicTimeline(1, 'nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a link that was not sent reads nothing, and is not a crash (P1-17)', async () => {
    await expect(makeWorld().getPublicTimeline(1, undefined as any)).rejects.toBeInstanceOf(NotFoundException);
    await expect(makeWorld().getPublicTimeline(1, '')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a job that does not exist and a wrong link get the same answer, so the route cannot be used to find which job numbers exist (P1-17)', async () => {
    const wrong: any = await makeWorld().getPublicTimeline(1, 'nope').catch((error) => error);
    const missing: any = await makeWorld({ jobExists: false }).getPublicTimeline(1, 'raw').catch((error) => error);

    expect(wrong.getStatus()).toBe(missing.getStatus());
    expect(wrong.message).toBe(missing.message);
  });

  it('a job with no link of its own (made by a signed-in customer) is not opened by an empty one (P1-17)', async () => {
    const prisma: any = {
      intervention: { findUnique: async () => ({ ...poisonedJob(), trackingToken: null }) },
      interventionEvent: { findMany: async () => [] },
    };

    await expect(new InterventionWorkflowService(prisma).getPublicTimeline(1, '')).rejects.toBeInstanceOf(NotFoundException);
  });
});
