import { InterventionsService, MAX_ISSUE_NOTES_LENGTH } from './interventions.service';

import { createHash } from 'crypto';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

function makeWorld() {
  const row: any = { id: 3, trackingToken: sha('secret'), status: 'ARTISAN_ARRIVED', feedbackNotes: null, hasIssue: false };
  const issues: any[] = [];

  const prisma: any = {
    intervention: {
      findFirst: async ({ where }: any) =>
        where.id === row.id && where.trackingToken === row.trackingToken && where.status.in.includes(row.status) ? { ...row } : null,
      // like Prisma: a field that is undefined is left alone
      update: async ({ data }: any) => Object.assign(row, Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined))),
    },
  };
  const gateway: any = { sendInterventionIssue: (payload: any) => issues.push(payload) };

  return { service: new InterventionsService(prisma, gateway, {} as any, {} as any, {} as any), row, issues };
}

async function failure(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('expected a failure');
}

describe('the public "report an issue" route (older tracking route)', () => {
  it('appends the report to the notes and tells the dashboard', async () => {
    const w = makeWorld();

    await w.service.reportActiveIssue(3, 'secret', 'Il y a une fuite');

    expect(w.row.hasIssue).toBe(true);
    expect(w.row.feedbackNotes.includes('Il y a une fuite')).toBe(true);
    expect(w.issues.length).toBe(1);
  });

  it('the notes stop growing at a ceiling: 429 and nothing appended', async () => {
    const w = makeWorld();
    const report = 'x'.repeat(1000);
    let accepted = 0;
    let refused: any;

    for (let i = 0; i < 20 && !refused; i++) {
      try {
        await w.service.reportActiveIssue(3, 'secret', report);
        accepted++;
      } catch (error) {
        refused = error;
      }
    }

    expect(accepted > 0 && accepted < 6).toBe(true);
    expect(refused.status).toBe(429);
    expect(w.row.feedbackNotes.length <= MAX_ISSUE_NOTES_LENGTH).toBe(true);
    expect(w.issues.length).toBe(accepted);
  });

  it('a wrong token is still a 404', async () => {
    const w = makeWorld();

    expect((await failure(w.service.reportActiveIssue(3, 'nope', 'Fuite'))).status).toBe(404);
  });
});

describe('the older review route does not wipe a reported problem (P1-04 review, pass 2)', () => {
  const review = (w: ReturnType<typeof makeWorld>, dto: any) => w.service.submitFeedback(3, 'secret', { rating: 5, isOnTime: true, ...dto });

  it('a form that posts every field, an empty text and "no problem" included, leaves the report and the flag', async () => {
    const w = makeWorld();
    w.row.status = 'COMPLETED';
    w.row.hasIssue = true;
    w.row.feedbackNotes = 'Fuite après le départ du technicien';

    await review(w, { feedbackNotes: '' });

    expect(w.row.hasIssue).toBe(true);
    expect(w.row.feedbackNotes).toBe('Fuite après le départ du technicien');
  });

  it('saying "no problem" with no report on the request is stored as before', async () => {
    const w = makeWorld();
    w.row.status = 'COMPLETED';

    await review(w, { hasIssue: false, feedbackNotes: 'Parfait' });

    expect(w.row.hasIssue).toBe(false);
    expect(w.row.feedbackNotes).toBe('Parfait');
  });

  it('a text sent with the review is added after the report, once', async () => {
    const w = makeWorld();
    w.row.status = 'COMPLETED';
    w.row.hasIssue = true;
    w.row.feedbackNotes = 'Fuite après le départ du technicien';

    await review(w, { feedbackNotes: 'Sinon très poli' });
    await review(w, { feedbackNotes: 'Sinon très poli' });

    expect(w.row.feedbackNotes).toBe('Fuite après le départ du technicien\n\nSinon très poli');
  });
});
