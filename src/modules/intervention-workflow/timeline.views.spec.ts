import { ForbiddenException } from '@nestjs/common';

import { leakedTo, poisonedJob } from '../../common/testing/poison';
import { InterventionWorkflowService } from './intervention-workflow.service';

/**
 * P1-08: the timeline of a job. The back office reads every line, with the author and the notes it
 * wrote for itself; the customer and the artisan read the lines meant for them. (The older route that gave the lines to a
 * visitor with the tracking link, and its tests, were deleted in P3-03; nothing called it.)
 */
function makeWorld() {
  const prisma: any = {
    intervention: {
      findUnique: async () => poisonedJob(),
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
});
