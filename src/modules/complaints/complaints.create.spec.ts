import { ComplaintsService } from './complaints.service';

function makeWorld(feedbackNotes: string | null = 'Merci, très bon travail') {
  const intervention: any = { id: 5, clientId: 50, artisanId: null, hasIssue: false, feedbackNotes };
  const opened: number[] = [];
  const updates: any[] = [];

  const prisma: any = {
    intervention: {
      findUnique: async () => ({ ...intervention, client: { id: 50 }, artisan: null }),
      update: async ({ data }: any) => {
        updates.push(data);
        Object.assign(intervention, data);

        return intervention;
      },
    },
    complaint: {
      create: async ({ data }: any) => ({ id: 9, ...data, messages: [] }),
    },
  };
  const notifications: any = { notifyComplaintOpened: async (id: number) => opened.push(id) };

  return { service: new ComplaintsService(prisma, notifications), intervention, opened, updates };
}

describe('opening a complaint (the request is flagged)', () => {
  it('by default the title replaces the notes of the request, as before', async () => {
    const w = makeWorld();

    await w.service.createComplaint(50, 'CLIENT' as any, 5, { title: 'Retard', description: 'Il est en retard' } as any);

    expect(w.intervention.hasIssue).toBe(true);
    expect(w.intervention.feedbackNotes).toBe('Retard');
    expect(w.opened).toEqual([9]);
  });

  it('with keepFeedbackNotes the request is flagged but its notes stay (a report from a tracking link)', async () => {
    const w = makeWorld();

    await w.service.createComplaint(
      50,
      'CLIENT' as any,
      5,
      { title: 'Retard', description: 'Il est en retard' } as any,
      { keepFeedbackNotes: true },
    );

    expect(w.intervention.hasIssue).toBe(true);
    expect(w.intervention.feedbackNotes).toBe('Merci, très bon travail');
    expect(w.updates).toEqual([{ hasIssue: true }]);
    expect(w.opened).toEqual([9]);
  });
});
