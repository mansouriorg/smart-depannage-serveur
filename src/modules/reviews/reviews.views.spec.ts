import { ForbiddenException } from '@nestjs/common';

import { leaked, leakedTo, nestedJob, poisonedReview, secret } from '../../common/testing/poison';
import { ReviewsService } from './reviews.service';

/**
 * P1-08: what the routes of the reviews answer. A secret is planted in the moderation of the review
 * and in the contact columns of the people and of the job it is about; a leak names itself.
 */
function makeWorld(review: Record<string, unknown> = {}) {
  const prisma: any = {
    intervention: {
      findUnique: async () => ({ ...nestedJob(), status: 'COMPLETED', review: null }),
    },
    review: {
      create: async ({ data }: any) => poisonedReview({ ...data, id: 9, status: 'PENDING', isVisible: false }),
      findUnique: async () => poisonedReview(review),
      findMany: async () => [poisonedReview(review), poisonedReview({ ...review, id: 2 })],
    },
    user: { findFirst: async () => ({ id: 20, role: 'ARTISAN' }) },
  };

  return new ReviewsService(prisma);
}

/** The artisan reads their own account whole; the customer reads their own. */
const THEIRS = ['review.artisan.email'];
const OWN_ACCOUNT = ['review.client.email', 'review.client.phone'];

describe('the reviews a customer reads (P1-08)', () => {
  it('the review just written: the customer\'s copy, waiting for the back office, with the artisan\'s name and number', async () => {
    const answer: any = await makeWorld().createReview(10, 'CLIENT' as any, 1, { rating: 5, comment: 'ok' } as any);

    expect(leakedTo(answer, 'client', OWN_ACCOUNT)).toEqual([]);
    expect(answer.review.status).toBe('PENDING');
    expect(answer.review.artisan).toEqual({ id: 20, name: 'Ali', phone: '+21621111111', artisanProfile: { specialty: 'PLUMBING', averageRating: 4.8, ratingCount: 12 } });
    expect(answer.review).not.toHaveProperty('moderationReason');
  });

  it('my reviews and the review of one of my jobs: the same copy', async () => {
    const world = makeWorld({ status: 'PENDING', isVisible: false });
    const mine: any[] = await world.findMyReviews(10, 'CLIENT' as any);
    const one: any = await world.findByIntervention(10, 'CLIENT' as any, 1);

    for (const answer of [...mine, one]) {
      expect(leakedTo(answer, 'client', OWN_ACCOUNT)).toEqual([]);
      expect(answer).not.toHaveProperty('moderatedById');
      expect(answer.client.email).toBe(secret('review.client.email'));
    }
  });

  it('by its number: the author reads their own, anybody else reads stars and words', async () => {
    const world = makeWorld();
    const author: any = await world.findOne(10, 'CLIENT' as any, 1);
    const stranger: any = await world.findOne(77, 'CLIENT' as any, 1);

    expect(leakedTo(author, 'client', OWN_ACCOUNT)).toEqual([]);
    expect(author.client.phone).toBe(secret('review.client.phone'));

    expect(leakedTo(stranger, 'room')).toEqual([]);
    expect(leaked(stranger)).toEqual([]);
    expect(stranger.rating).toBe(5);
    expect(stranger.client).toEqual({ name: 'Salah' });
    expect(stranger.intervention).toEqual({
      id: 1,
      serviceType: 'PLUMBING',
      createdAt: new Date('2026-10-01T10:00:00Z'),
      workCompletedAt: new Date('2026-10-02T10:00:00Z'),
    });
    expect(JSON.stringify(stranger)).not.toContain('+21620000000');
  });

  it('a review that is not approved is not shown to a stranger', async () => {
    await expect(makeWorld({ status: 'PENDING', isVisible: false }).findOne(77, 'CLIENT' as any, 1)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('the reviews an artisan reads (P1-08)', () => {
  it('the review of their job: the customer\'s name, nothing to reach them by', async () => {
    const world = makeWorld();
    const byJob: any = await world.findByIntervention(20, 'ARTISAN' as any, 1);
    const byNumber: any = await world.findOne(20, 'ARTISAN' as any, 1);

    for (const answer of [byJob, byNumber]) {
      expect(leakedTo(answer, 'artisan', THEIRS)).toEqual([]);
      expect(answer.client).toEqual({ id: 10, name: 'Salah' });
      expect(answer.artisan).toEqual({ id: 20, name: 'Ali' });
      expect(answer).not.toHaveProperty('moderationReason');
      expect(answer).not.toHaveProperty('status');
    }
  });

  it('a review that is waiting for the back office is not shown to them', async () => {
    expect(await makeWorld({ status: 'PENDING', isVisible: false }).findByIntervention(20, 'ARTISAN' as any, 1)).toBeNull();
  });
});

describe('the reviews on a profile (P1-08)', () => {
  it('stars and words, a first name, no moderation', async () => {
    const answer: any[] = await makeWorld().findVisibleArtisanReviews(20);

    expect(answer.length).toBe(2);

    for (const review of answer) {
      expect(leaked(review)).toEqual([]);
      expect(review).not.toHaveProperty('moderatedById');
      expect(review).not.toHaveProperty('moderationReason');
      expect(review.client).toEqual({ name: 'Salah' });
    }
  });
});

describe('the back office and the reviews (P1-08)', () => {
  it('reads the row as it is, with the moderation', async () => {
    const world = makeWorld();

    for (const answer of [await world.findOne(5, 'SUPPORT' as any, 1), await world.findByIntervention(5, 'ADMIN' as any, 1)] as any[]) {
      expect(answer.moderationReason).toBe(secret('review.moderationReason'));
    }
  });
});
