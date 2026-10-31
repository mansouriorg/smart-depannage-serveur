import { ComplaintsService } from './complaints.service';

/**
 * What a back-office account reads on GET /complaints/me: the fifty newest complaints and the total. (Until P3-03 the same service
 * method also took filters and a page for GET /complaints/admin; that route is gone and GET /admin/complaints is the list with filters.)
 */
function makeWorld(total = 77) {
  const asked: { findMany?: any; count?: any } = {};
  const rows = [
    { id: 3, userId: 10, title: 'Fuite', status: 'OPEN' },
    { id: 2, userId: 11, title: 'Retard', status: 'IN_REVIEW' },
  ];
  const prisma: any = {
    complaint: {
      findMany: async (args: any) => {
        asked.findMany = args;

        return rows;
      },
      count: async (args: any) => {
        asked.count = args;

        return total;
      },
    },
  };

  return { service: new ComplaintsService(prisma, {} as any), asked, rows };
}

describe('the complaints a back-office account reads on GET /complaints/me (P3-03)', () => {
  it.each(['ADMIN', 'SUPER_ADMIN', 'SUPPORT', 'DISPATCHER', 'ACCOUNTANT'])('%s: the fifty newest, with the total, from the first', async (role) => {
    const w = makeWorld();

    const answer: any = await w.service.findMyComplaints(5, role as any);

    expect(answer).toEqual({ total: 77, skip: 0, take: 50, items: w.rows });
    expect(w.asked.findMany.where).toEqual({});
    expect(w.asked.findMany.orderBy).toEqual({ createdAt: 'desc' });
    expect(w.asked.findMany.skip).toBe(0);
    expect(w.asked.findMany.take).toBe(50);
    expect(w.asked.count).toEqual({ where: {} });
  });

  it('the list takes no filter and no page: whatever is passed after the role is not read', async () => {
    const w = makeWorld();

    await (w.service as any).findMyComplaints(5, 'ADMIN', { status: 'OPEN', assignedToId: 3, refundRequested: true, skip: 10, take: 5 });

    expect(w.asked.findMany.where).toEqual({});
    expect(w.asked.findMany.skip).toBe(0);
    expect(w.asked.findMany.take).toBe(50);
    expect(w.asked.count).toEqual({ where: {} });
    expect((ComplaintsService.prototype as any).adminFindAll).toBe(undefined);
  });
});
