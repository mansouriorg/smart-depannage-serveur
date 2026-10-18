import { leaked, leakedTo, nestedJob, poisonedComplaint, secret } from '../../common/testing/poison';
import { ComplaintsService } from './complaints.service';

/**
 * P1-08: what the routes of the complaints answer to the customer and to the artisan of the job.
 * A secret is planted in the notes, in the staff member who handles the complaint, in the contact
 * columns of everybody on the thread and in the messages meant for the back office.
 */
function makeWorld(complaint: Record<string, unknown> = {}) {
  const prisma: any = {
    intervention: {
      findUnique: async () => ({ ...nestedJob(), status: 'COMPLETED', hasIssue: false, feedbackNotes: null }),
      update: async () => ({}),
    },
    complaint: {
      findUnique: async () => poisonedComplaint(complaint),
      findMany: async () => [poisonedComplaint(complaint), poisonedComplaint({ ...complaint, id: 2 })],
      create: async ({ data }: any) => poisonedComplaint({ ...complaint, ...data, id: 9 }),
      update: async ({ data }: any) => poisonedComplaint({ ...complaint, ...data }),
    },
    complaintMessage: {
      create: async ({ data }: any) => ({
        id: 7,
        ...data,
        deletedAt: null,
        createdAt: new Date(),
        sender: { id: data.senderId, name: 'Qui', email: secret('complaint.sender.email'), phone: secret('complaint.sender.phone'), role: data.senderRole },
      }),
    },
  };
  const notifications: any = {
    notifyComplaintOpened: async () => undefined,
    notifyComplaintReply: async () => undefined,
    notifyComplaintUpdated: async () => undefined,
  };

  return new ComplaintsService(prisma, notifications);
}

const customer = { id: 10, role: 'CLIENT' as any };
const artisan = { id: 20, role: 'ARTISAN' as any };

/** Everything the thread of a complaint shows the customer and the artisan. */
function expectClean(answer: any, viewer: 'client' | 'artisan') {
  expect(leakedTo(answer, viewer)).toEqual([]);
  // (the job on the complaint: both are given what the job is and the way to reach the customer, nothing else)
  expect(leaked(answer)).toEqual(['job.address', 'job.contactName', 'job.contactPhone', 'job.description']);
  expect(answer).not.toHaveProperty('adminNotes');
  expect(answer).not.toHaveProperty('assignedTo');
  expect(answer).not.toHaveProperty('assignedToId');
  expect(answer.user).toEqual({ id: 10, name: 'Salah', role: 'CLIENT' });
  expect(answer.messages.map((message: any) => message.id)).toEqual([1, 2]);

  for (const message of answer.messages) {
    expect(Object.keys(message.sender).sort()).toEqual(['id', 'name', 'role']);
    expect(message).not.toHaveProperty('isInternal');
    expect(message).not.toHaveProperty('deletedAt');
  }
}

describe('the complaints a customer or an artisan reads (P1-08)', () => {
  it('one complaint: the decision and the public thread, the people as names', async () => {
    const service = makeWorld();

    expectClean(await service.findOne(10, customer.role, 1), 'client');
    expectClean(await service.findOne(20, artisan.role, 1), 'artisan');
  });

  it('the complaints of a job and my complaints', async () => {
    const service = makeWorld();

    for (const answer of [
      ...(await service.findByIntervention(10, customer.role, 1)),
      ...(await service.findMyComplaints(10, customer.role)),
    ] as any[]) {
      expectClean(answer, 'client');
    }

    for (const answer of [
      ...(await service.findByIntervention(20, artisan.role, 1)),
      ...(await service.findMyComplaints(20, artisan.role)),
    ] as any[]) {
      expectClean(answer, 'artisan');
    }
  });

  it('a complaint just opened', async () => {
    const answer: any = await makeWorld().createComplaint(10, customer.role, 1, { title: 'Retard', description: 'Il est en retard' } as any);

    expect(leakedTo(answer, 'client')).toEqual([]);
    expect(answer).not.toHaveProperty('adminNotes');
    expect(answer).not.toHaveProperty('assignedTo');
  });

  it('a message added to the thread, and the artisan\'s answer: the writer is a name', async () => {
    const service = makeWorld();
    const message: any = await service.addMessage(10, customer.role, 1, { content: 'Bonjour' } as any);
    const answered: any = await service.artisanResponse(20, artisan.role, 1, { response: 'Désolé' } as any);

    for (const copy of [message, answered.message]) {
      expect(leaked(copy)).toEqual([]);
      expect(copy).not.toHaveProperty('isInternal');
      expect(copy.content).toBeDefined();
    }

    expect(Object.keys(message.sender).sort()).toEqual(['id', 'name', 'role']);
    expectClean(answered.complaint, 'artisan');
  });
});

describe('the back office and the complaints (P1-08)', () => {
  it('reads the complaint as it is: notes, who handles it, the internal messages', async () => {
    const answer: any = await makeWorld().findOne(5, 'SUPPORT' as any, 1);

    expect(answer.adminNotes).toBe(secret('complaint.adminNotes'));
    expect(answer.assignedTo.email).toBe(secret('complaint.assignedTo.email'));
    expect(answer.messages.map((message: any) => message.id)).toEqual([1, 2, 3, 4]);
    expect(answer.messages[0].sender.email).toBe(secret('complaint.sender.email'));
  });

  it('a message of its own for the back office stays as it is', async () => {
    const answer: any = await makeWorld().addMessage(5, 'SUPPORT' as any, 1, { content: 'Note', isInternal: true } as any);

    expect(answer.isInternal).toBe(true);
    expect(answer.sender.email).toBe(secret('complaint.sender.email'));
  });
});
