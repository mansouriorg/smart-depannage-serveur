import { resetLocale } from '../../common/locale/locale';
import { World, emptyWorld } from '../../common/testing/world';

/** The moderation queue on the real service and the in-memory database (P2-09). */

const at = (iso: string) => new Date(iso);

interface Queue {
  world: World;
  admin: any;
  artisan: any;
  other: any;
  r: Record<string, any>;
}

function queue(): Queue {
  const world = emptyWorld();
  const m = world.memory;
  const person = (role: string, name: string) => m.plant('user', { role, name, email: `${name.toLowerCase().replace(/\W+/g, '.')}@example.test`, phone: null });
  const admin = person('ADMIN', 'Admin Chef');
  const artisan = person('ARTISAN', 'Karim Plombier');
  const other = person('ARTISAN', 'Hedi Electricien');
  const salma = person('CLIENT', 'Salma Ben Ali');
  const ali = person('CLIENT', 'Ali Trabelsi');

  m.plant('artisanProfile', { userId: artisan.id, averageRating: 0, ratingCount: 0 });
  m.plant('artisanProfile', { userId: other.id, averageRating: 0, ratingCount: 0 });

  const review = (data: Record<string, any>) => {
    const job = m.plant('intervention', { clientId: data.clientId ?? salma.id, artisanId: data.artisanId ?? artisan.id, status: 'COMPLETED', serviceType: 'PLOMBIER', address: 'Tunis', description: 'Fuite' });

    return m.plant('review', { interventionId: job.id, clientId: salma.id, artisanId: artisan.id, rating: 5, comment: 'Très bien', status: 'PENDING', isVisible: false, ...data });
  };

  const r: Record<string, any> = {
    wait1: review({ rating: 1, comment: 'Jamais venu', createdAt: at('2026-10-20T08:00:00Z') }),
    wait2: review({ rating: 2, comment: 'Retard énorme', clientId: ali.id, createdAt: at('2026-10-21T08:00:00Z') }),
    good: review({ rating: 5, comment: 'Parfait', status: 'APPROVED', isVisible: true, createdAt: at('2026-10-19T08:00:00Z') }),
    fine: review({ rating: 3, comment: 'Correct', status: 'APPROVED', isVisible: true, createdAt: at('2026-10-18T08:00:00Z') }),
    rude: review({ rating: 1, comment: 'Insulte', status: 'REJECTED', isVisible: false, moderationReason: 'Propos injurieux', createdAt: at('2026-10-17T08:00:00Z') }),
    hidden: review({ rating: 4, comment: 'Sous évier', status: 'HIDDEN', isVisible: false, moderationReason: 'À la demande du client', artisanId: other.id, createdAt: at('2026-10-16T08:00:00Z') }),
  };

  return { world, admin, artisan, other, r };
}

const idsOf = (page: { items: Array<{ id: number }> }) => page.items.map((row) => row.id);

async function refusal(work: () => Promise<unknown>): Promise<{ status: number; message: string } | null> {
  try {
    await work();
  } catch (error) {
    const known = error as { getStatus?: () => number; message?: string };

    return { status: typeof known.getStatus === 'function' ? known.getStatus() : 500, message: String(known.message) };
  }

  return null;
}

describe('the moderation queue (P2-09)', () => {
  beforeEach(() => resetLocale());

  it('holds every review, the newest first, with the size of each tab', async () => {
    const { world, admin, r } = queue();
    const page = await world.svc.reviews.adminFindAll(admin.id, 'ADMIN' as any, {});

    expect(idsOf(page)).toEqual([r.wait2.id, r.wait1.id, r.good.id, r.fine.id, r.rude.id, r.hidden.id]);
    expect(page).toMatchObject({ total: 6, skip: 0, take: 50 });
    expect(page.counts).toEqual({ all: 6, PENDING: 2, APPROVED: 2, REJECTED: 1, HIDDEN: 1 });
  });

  it('answers a page that makes no sense with a page, not with a failure of the database', async () => {
    const { world, admin, r } = queue();
    const ask = (query: Record<string, unknown>) => world.svc.reviews.adminFindAll(admin.id, 'ADMIN' as any, query as any);

    expect(await ask({ skip: -4, take: -2 })).toMatchObject({ skip: 0, take: 1, total: 6 });
    expect(idsOf(await ask({ skip: -4, take: -2 }))).toEqual([r.wait2.id]);
    expect(await ask({ skip: 9_999_999_999, take: 1000 })).toMatchObject({ skip: 1_000_000, take: 100, total: 6, items: [] });
  });

  it('shows the oldest first when asked, to work the waiting ones in the order they came', async () => {
    const { world, admin, r } = queue();
    const page = await world.svc.reviews.adminFindAll(admin.id, 'ADMIN' as any, { status: 'PENDING', sort: 'oldest' } as any);

    expect(idsOf(page)).toEqual([r.wait1.id, r.wait2.id]);
  });

  it('a tab shows its own status, and counts every tab under the same filters, not under its own status', async () => {
    const { world, admin, r } = queue();
    const page = await world.svc.reviews.adminFindAll(admin.id, 'ADMIN' as any, { status: 'APPROVED', maxRating: 3 } as any);

    expect(idsOf(page)).toEqual([r.fine.id]);
    expect(page.total).toBe(1);
    expect(page.counts).toEqual({ all: 4, PENDING: 2, APPROVED: 1, REJECTED: 1, HIDDEN: 0 });
  });

  it('finds the reviews at most as good as a number of stars', async () => {
    const { world, admin, r } = queue();
    const page = await world.svc.reviews.adminFindAll(admin.id, 'ADMIN' as any, { maxRating: 2, sort: 'oldest' } as any);

    expect(idsOf(page)).toEqual([r.rude.id, r.wait1.id, r.wait2.id]);
  });

  it('finds a review by its words, by the people, by its number or by the number of its job', async () => {
    const { world, admin, r } = queue();
    const find = async (search: string) => idsOf(await world.svc.reviews.adminFindAll(admin.id, 'ADMIN' as any, { search, sort: 'oldest' } as any));

    expect(await find('RETARD')).toEqual([r.wait2.id]);
    expect(await find('trabelsi')).toEqual([r.wait2.id]);
    expect(await find('hedi')).toEqual([r.hidden.id]);
    expect(await find(`#${r.good.id}`)).toContain(r.good.id);
    expect(await find(String(r.fine.interventionId))).toContain(r.fine.id);
    expect(await find('nobody-at-all')).toEqual([]);
  });

  it('shows the reviews of one artisan, and nothing for a number that is none', async () => {
    const { world, admin, other, r } = queue();

    expect(idsOf(await world.svc.reviews.adminFindAll(admin.id, 'ADMIN' as any, { artisanId: other.id } as any))).toEqual([r.hidden.id]);
    expect(idsOf(await world.svc.reviews.adminFindAll(admin.id, 'ADMIN' as any, { artisanId: 'abc' } as any))).toEqual([]);
  });

  it('pages, and breaks ties by the number so that no review is lost between two pages', async () => {
    const { world, admin } = queue();

    world.set('review', { createdAt: at('2026-10-20T08:00:00Z') }, () => true);

    const seen: number[] = [];

    for (const skip of [0, 2, 4, 6]) seen.push(...idsOf(await world.svc.reviews.adminFindAll(admin.id, 'ADMIN' as any, { skip, take: 2, sort: 'oldest' } as any)));

    expect(seen).toHaveLength(6);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  it('is for the back office only', async () => {
    const { world, artisan } = queue();
    const failure = await refusal(() => world.svc.reviews.adminFindAll(artisan.id, 'ARTISAN' as any, {}));

    expect(failure?.status).toBe(403);
  });
});

describe('the decision on a review (P2-09)', () => {
  beforeEach(() => resetLocale());

  const decide = (q: Queue, review: any, status: string, moderationReason?: string) => q.world.svc.reviews.moderateReview(q.admin.id, 'ADMIN' as any, review.id, { status, moderationReason } as any);
  const stored = (q: Queue, review: any) => q.world.memory.rows('review').find((row: any) => row.id === review.id);
  const profile = (q: Queue, artisan: any) => q.world.memory.rows('artisanProfile').find((row: any) => row.userId === artisan.id);

  it('approves a review with no reason: it shows, and the artisan\'s rating is counted again', async () => {
    const q = queue();
    const done = await decide(q, q.r.wait2, 'APPROVED');

    expect(done).toMatchObject({ id: q.r.wait2.id, status: 'APPROVED', isVisible: true, moderatedById: q.admin.id, moderationReason: null });
    expect(stored(q, q.r.wait2).moderatedAt).toBeInstanceOf(Date);
    expect(profile(q, q.artisan)).toMatchObject({ ratingCount: 3, averageRating: 3.33 });
  });

  it('refuses a review for a reason, trimmed, and it no longer counts in the rating', async () => {
    const q = queue();

    await decide(q, q.r.wait1, 'APPROVED');
    expect(profile(q, q.artisan)).toMatchObject({ ratingCount: 3 });

    await decide(q, q.r.good, 'REJECTED', '  Propos injurieux  ');

    expect(stored(q, q.r.good)).toMatchObject({ status: 'REJECTED', isVisible: false, moderationReason: 'Propos injurieux' });
    expect(profile(q, q.artisan)).toMatchObject({ ratingCount: 2, averageRating: 2 });
  });

  it('hides an approved review for a reason', async () => {
    const q = queue();

    await decide(q, q.r.fine, 'HIDDEN', 'À la demande du client');

    expect(stored(q, q.r.fine)).toMatchObject({ status: 'HIDDEN', isVisible: false, moderationReason: 'À la demande du client' });
    expect(profile(q, q.artisan)).toMatchObject({ ratingCount: 1, averageRating: 5 });
  });

  it('changes nothing, and says why, when a review is refused or hidden with no reason', async () => {
    const q = queue();

    for (const status of ['REJECTED', 'HIDDEN']) {
      for (const reason of [undefined, '', '   ']) {
        const failure = await refusal(() => decide(q, q.r.wait1, status, reason));

        expect(failure).toEqual({ status: 400, message: 'Indiquez pourquoi cet avis est refusé ou masqué.' });
      }
    }

    expect(stored(q, q.r.wait1)).toMatchObject({ status: 'PENDING', isVisible: false, moderatedById: null, moderatedAt: null });
  });

  it('refuses a reason of more than 500 characters', async () => {
    const q = queue();
    const failure = await refusal(() => decide(q, q.r.wait1, 'HIDDEN', 'a'.repeat(501)));

    expect(failure).toEqual({ status: 400, message: 'La raison ne peut pas dépasser 500 caractères.' });
    expect(stored(q, q.r.wait1).status).toBe('PENDING');
  });

  it('keeps a NUL byte out of the reason, which PostgreSQL refuses, and asks again for a reason that was only that', async () => {
    const q = queue();

    await decide(q, q.r.wait1, 'REJECTED', 'Propos\u0000 injurieux');

    expect(stored(q, q.r.wait1)).toMatchObject({ status: 'REJECTED', moderationReason: 'Propos injurieux' });

    const failure = await refusal(() => decide(q, q.r.wait2, 'HIDDEN', '\u0000 \u0000'));

    expect(failure).toEqual({ status: 400, message: 'Indiquez pourquoi cet avis est refusé ou masqué.' });
    expect(stored(q, q.r.wait2).status).toBe('PENDING');
  });

  it('still finds a review by a text with "%" in it, the escape being read as LIKE reads it', async () => {
    const q = queue();
    const reviewed = q.world.memory.rows('review').find((row: any) => row.id === q.r.good.id);

    // The in-memory double reads the backslash as LIKE does (the next character is literal); that the escape is added is checked on the `where` itself.
    reviewed.comment = 'Remise de 50% accordée';

    const page = await q.world.svc.reviews.adminFindAll(q.admin.id, 'ADMIN' as any, { search: '50%' } as any);

    expect(idsOf(page)).toEqual([q.r.good.id]);
    expect((await q.world.svc.reviews.adminFindAll(q.admin.id, 'ADMIN' as any, { search: '%' } as any)).total).toBe(1);
  });

  it('puts a decision back: the reason of a refusal is dropped when the review is approved after all', async () => {
    const q = queue();

    await decide(q, q.r.rude, 'APPROVED');

    expect(stored(q, q.r.rude)).toMatchObject({ status: 'APPROVED', isVisible: true, moderationReason: null });
  });

  it('does not know a review that does not exist, and is for the back office only', async () => {
    const q = queue();

    expect((await refusal(() => q.world.svc.reviews.moderateReview(q.admin.id, 'ADMIN' as any, 9999, { status: 'APPROVED' } as any)))?.status).toBe(404);
    expect((await refusal(() => q.world.svc.reviews.moderateReview(q.artisan.id, 'ARTISAN' as any, q.r.wait1.id, { status: 'APPROVED' } as any)))?.status).toBe(403);
    expect(stored(q, q.r.wait1).status).toBe('PENDING');
  });
});
