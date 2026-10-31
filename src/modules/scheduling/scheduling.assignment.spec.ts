import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { SchedulingService } from './scheduling.service';
import { MatchingService } from '../matching/matching.service';
import { ACTIVE_APPOINTMENT_STATUSES } from '../assignment/artisan-availability';

/**
 * Scheduling an intervention is the assignment path with a time (P1-05), and the
 * weekly hours of an artisan are read by the same rule as in the matching.
 */

const slot = (dayOfWeek: string, startTime: string, endTime: string, isAvailable = true) => ({
  dayOfWeek,
  startTime,
  endTime,
  isAvailable,
});

function makeScheduling(options: { availability?: any[]; appointments?: any[]; blocks?: any[]; assignImpl?: (i: any) => Promise<any> } = {}) {
  const assigned: any[] = [];
  const calls: string[] = [];
  const queries: any = {};
  const told: any[] = [];

  const prisma: any = {
    artisanProfile: {
      findUnique: async () => ({ userId: 4, availability: options.availability ?? [] }),
    },
    appointment: {
      findMany: async (args: any) => {
        queries.appointments = args;
        return options.appointments ?? [];
      },
      findUnique: async ({ where }: any) => ({ id: where.id, interventionId: 8, artisanId: 4, startsAt: new Date(), requests: [], reminders: [] }),
    },
    artisanTimeBlock: {
      findMany: async () => options.blocks ?? [],
    },
    intervention: {
      update: async () => {
        calls.push('intervention.update');
      },
    },
  };
  const assignment: any = {
    assign:
      options.assignImpl ??
      (async (input: any) => {
        assigned.push(input);
        return { intervention: { id: input.interventionId }, appointment: { id: 77 } };
      }),
  };
  const notifications: any = { notify: async (...args: any[]) => told.push(args) };

  return { service: new SchedulingService(prisma, assignment, notifications), assigned, calls, queries, told };
}

async function failure(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('expected a failure');
}

const dto = { artisanId: 4, startsAt: '2026-10-19T08:00:00.000Z', endsAt: '2026-10-19T09:00:00.000Z', adminNote: 'Code 1234' };

describe('SchedulingService.scheduleIntervention goes through the assignment path', () => {
  it('only staff', async () => {
    const w = makeScheduling();

    for (const role of ['CLIENT', 'ARTISAN']) {
      const error = await failure(w.service.scheduleIntervention(1, role as any, 8, dto));

      expect(error instanceof ForbiddenException).toBe(true);
    }

    expect(w.assigned).toEqual([]);
  });

  it('hands the artisan, the time and the note to the assignment, as the staff member who asked', async () => {
    const w = makeScheduling();

    await w.service.scheduleIntervention(1, 'DISPATCHER' as any, 8, dto);

    expect(w.assigned.length).toBe(1);
    expect(w.assigned[0]).toEqual({
      interventionId: 8,
      artisanId: 4,
      actorId: 1,
      startsAt: dto.startsAt,
      endsAt: dto.endsAt,
      adminNote: 'Code 1234',
    });
  });

  it('answers with the appointment the assignment made', async () => {
    const w = makeScheduling();

    const result: any = await w.service.scheduleIntervention(1, 'ADMIN' as any, 8, dto);

    expect(result.id).toBe(77);
  });

  it('does not overwrite the date and hours the client asked for, and does not tell anybody itself', async () => {
    const w = makeScheduling();

    await w.service.scheduleIntervention(1, 'ADMIN' as any, 8, dto);

    expect(w.calls).toEqual([]);
    expect(w.told).toEqual([]);
  });

  it('an artisan who is not approved, busy, or a job in the wrong status: the refusal comes back, nothing else happens', async () => {
    const refusal = new BadRequestException({ message: 'Cet artisan n’est pas disponible.', issues: ['Artisan déjà réservé sur ce créneau.'] });
    const w = makeScheduling({
      assignImpl: async () => {
        throw refusal;
      },
    });

    const error = await failure(w.service.scheduleIntervention(1, 'ADMIN' as any, 8, dto));

    expect(error).toBe(refusal);
    expect(w.calls).toEqual([]);
    expect(w.told).toEqual([]);
  });
});

describe('the double-booking check reads the hours with the shared rule', () => {
  const check = (w: ReturnType<typeof makeScheduling>, startsAt: string, endsAt: string) =>
    (w.service as any).checkDoubleBooking({ artisanId: 4, startsAt: new Date(startsAt), endsAt: new Date(endsAt) });

  it('looks at the appointments that hold the artisan\'s time, the shared list', async () => {
    const w = makeScheduling();

    await check(w, dto.startsAt, dto.endsAt);

    expect(w.queries.appointments.where.status.in).toEqual(ACTIVE_APPOINTMENT_STATUSES);
  });

  it('no schedule: free; a Monday schedule: not free on a Sunday', async () => {
    const none = await check(makeScheduling(), '2026-10-18T08:00:00.000Z', '2026-10-18T09:00:00.000Z');
    const monday = await check(
      makeScheduling({ availability: [slot('MONDAY', '08:00', '17:00')] }),
      '2026-10-18T08:00:00.000Z',
      '2026-10-18T09:00:00.000Z',
    );

    expect(none.available).toBe(true);
    expect(monday.available).toBe(false);
    expect(monday.withinAvailability).toBe(false);
  });

  it('the hours are the hours in Tunis: 08:00 UTC is 09:00 there', async () => {
    const w = makeScheduling({ availability: [slot('MONDAY', '09:00', '10:00')] });

    expect((await check(w, '2026-10-19T08:00:00.000Z', '2026-10-19T09:00:00.000Z')).available).toBe(true);
    expect((await check(w, '2026-10-19T09:00:00.000Z', '2026-10-19T10:00:00.000Z')).available).toBe(false);
  });

  it('an overlapping appointment or block makes the artisan not free', async () => {
    expect((await check(makeScheduling({ appointments: [{ id: 1 }] }), dto.startsAt, dto.endsAt)).available).toBe(false);
    expect((await check(makeScheduling({ blocks: [{ id: 1 }] }), dto.startsAt, dto.endsAt)).available).toBe(false);
  });
});

describe('the matching and the scheduling agree on the weekly hours (they used to disagree on an empty day)', () => {
  const cases: [string, any[], string, string][] = [
    ['no schedule at all', [], '2026-10-18T08:00:00.000Z', '2026-10-18T09:00:00.000Z'],
    ['a Monday schedule, asked for a Sunday', [slot('MONDAY', '08:00', '17:00')], '2026-10-18T08:00:00.000Z', '2026-10-18T09:00:00.000Z'],
    ['a Monday schedule, asked inside it', [slot('MONDAY', '08:00', '17:00')], '2026-10-19T08:00:00.000Z', '2026-10-19T09:00:00.000Z'],
    ['a Monday schedule, asked before it opens', [slot('MONDAY', '09:00', '17:00')], '2026-10-19T07:00:00.000Z', '2026-10-19T08:00:00.000Z'],
    ['a Monday schedule, asked after it closes', [slot('MONDAY', '08:00', '12:00')], '2026-10-19T11:30:00.000Z', '2026-10-19T12:30:00.000Z'],
    ['only unavailable slots', [slot('MONDAY', '08:00', '17:00', false)], '2026-10-19T08:00:00.000Z', '2026-10-19T09:00:00.000Z'],
    ['an appointment over midnight', [slot('MONDAY', '00:00', '24:00')], '2026-10-19T22:30:00.000Z', '2026-10-19T23:30:00.000Z'],
    ['the whole week', ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'].map((d) => slot(d, '00:00', '24:00')), '2026-10-18T08:00:00.000Z', '2026-10-18T09:00:00.000Z'],
  ];

  for (const [name, availability, startsAt, endsAt] of cases) {
    it(name, async () => {
      const scheduling = makeScheduling({ availability });
      const verdict = await (scheduling.service as any).checkDoubleBooking({
        artisanId: 4,
        startsAt: new Date(startsAt),
        endsAt: new Date(endsAt),
      });

      const prisma: any = {
        user: {
          findMany: async () => [
            {
              id: 4,
              name: 'A',
              email: 'a@example.tn',
              phone: '+21620000004',
              latitude: null,
              longitude: null,
              artisanProfile: {
                serviceTypes: ['PLOMBIER'],
                specialty: null,
                specialties: [],
                serviceZones: [],
                availability,
                availabilityStatus: 'ONLINE',
                isAcceptingJobs: true,
                emergencyAvailable: true,
                maxActiveJobs: 3,
                verificationStatus: 'APPROVED',
                averageRating: 4.5,
                completedJobsCount: 0,
                cancelledJobsCount: 0,
              },
              artisanInterventions: [],
              artisanAppointments: [],
              artisanTimeBlocks: [],
            },
          ],
        },
      };
      const matching = new MatchingService(prisma, {} as any);
      const [match] = await matching.findMatchingArtisans(1, 'ADMIN' as any, { serviceType: 'PLOMBIER', startsAt, endsAt } as any);

      expect(match.isAvailable).toBe(verdict.available);
    });
  }
});

describe('approving a request to move an appointment (same rule, reminders made again)', () => {
  type ReviewOptions = {
    availability?: any[];
    overlapping?: any[];
    type?: 'RESCHEDULE' | 'CANCEL';
    /** What the request says when it is read again under the lock (the first read says PENDING, artisan 4). */
    fresh?: any;
    freshAppointment?: any;
    jobStatus?: string;
    /** The artisan the job has now (default: the one the appointment is in the name of). */
    jobArtisanId?: number | null;
    appointmentStatus?: string;
    /** The other requests of the appointment that still wait (P3-01), as the lock-held read finds them. */
    waiting?: any[];
    /** The payments of the job (P3-01): what it holds when it is cancelled. */
    payments?: any[];
    /** The invoices of the job: what still stands against the money it holds when it is cancelled. */
    invoices?: any[];
    /** What the visit shows when the request was made: what a refusal puts back (P3-01). */
    previousStatus?: string | null;
    confirmedAt?: Date | null;
    /** The notice to the people who handle money fails (it must not undo the cancellation). */
    noticeFails?: boolean;
  };

  function makeReview(options: ReviewOptions = {}) {
    const deleted: any[] = [];
    const created: any[] = [];
    const moves: any[] = [];
    const cancels: any[] = [];
    const jobWrites: any[] = [];
    const approvals: any[] = [];
    const rejections: any[] = [];
    const siblings: any[] = [];
    const statusWrites: any[] = []; // writes of the visit's status alone (a refusal puts it back, an approved move leaves it planned)
    const timeline: any[] = []; // the lines written in the job's timeline
    const events: string[] = []; // the order of what happened, with where it happened
    const request: any = {
      id: 5,
      status: 'PENDING',
      type: options.type ?? 'RESCHEDULE',
      reason: 'Empêchement',
      appointmentId: 12,
      requestedStartAt: new Date('2099-10-19T08:00:00.000Z'),
      requestedEndAt: new Date('2099-10-19T09:00:00.000Z'),
      previousStatus: options.previousStatus === undefined ? 'SCHEDULED' : options.previousStatus,
      appointment: {
        id: 12,
        interventionId: 8,
        artisanId: 4,
        clientId: 2,
        status: options.appointmentStatus ?? 'SCHEDULED',
        confirmedAt: options.confirmedAt ?? null,
      },
    };

    const locks: any[] = [];
    const queries: any[] = [];
    const reads: string[] = []; // where each look at the artisan's calendar was made: 'tx' or 'outside'

    const tables = (where: string) => ({
      artisanProfile: {
        findUnique: async () => {
          reads.push(where);
          events.push(`${where}:profile`);
          return { userId: 4, availability: options.availability ?? [] };
        },
      },
      appointment: {
        findMany: async (args: any) => {
          reads.push(where);
          events.push(`${where}:overlaps`);
          queries.push(args);
          return options.overlapping ?? [];
        },
        update: async ({ data }: any) => {
          reads.push(`${where}-write`);

          if (data.status === 'CANCELLED') {
            events.push(`${where}:cancel-appointment`);
            cancels.push(data);
            return { id: 12 };
          }

          if (data.startsAt === undefined && data.endsAt === undefined) {
            events.push(`${where}:visit-status`);
            statusWrites.push(data);
            return { id: 12, ...data };
          }

          events.push(`${where}:move`);
          moves.push(data);
          return { id: 12, clientId: 2, artisanId: 4, startsAt: data.startsAt, endsAt: data.endsAt };
        },
      },
      artisanTimeBlock: {
        findMany: async () => {
          reads.push(where);
          return [];
        },
      },
    });

    // The transaction is another object than the client: what is read or written through the
    // client while the lock is held is not under the lock.
    const tx: any = {
      ...tables('tx'),
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        locks.push({ sql: strings.join('?'), values, movesSoFar: moves.length });
        events.push(`lock:${values.join(',')}`);
        return 1;
      },
      appointmentRequest: {
        findUnique: async () => {
          events.push('tx:read-request');
          return {
            ...request,
            ...(options.fresh ?? {}),
            appointment: { ...request.appointment, ...(options.freshAppointment ?? {}) },
          };
        },
        findMany: async () => {
          events.push('tx:read-waiting');
          return options.waiting ?? [];
        },
        updateMany: async (args: any) => {
          events.push('tx:close-siblings');
          siblings.push(args);
          return { count: 1 };
        },
        update: async ({ data }: any) => {
          events.push('tx:answer-request');
          (data.status === 'APPROVED' ? approvals : rejections).push(data);
          return { ...request, ...data };
        },
      },
      appointmentReminder: {
        deleteMany: async (args: any) => {
          events.push('tx:reminders-deleted');
          deleted.push(args);
        },
        createMany: async (args: any) => {
          events.push('tx:reminders-made');
          created.push(args);
        },
      },
      intervention: {
        findUnique: async () => ({
          status: options.jobStatus ?? 'ASSIGNED',
          artisanId: options.jobArtisanId === undefined ? 4 : options.jobArtisanId,
        }),
        update: async ({ data }: any) => {
          events.push('tx:job');
          jobWrites.push(data);
          return { id: 8, ...data };
        },
      },
      payment: {
        findMany: async () => options.payments ?? [],
      },
      invoice: {
        findMany: async () => options.invoices ?? [],
      },
      interventionEvent: {
        create: async ({ data }: any) => {
          events.push('tx:timeline');
          timeline.push(data);
          return { id: timeline.length, ...data };
        },
      },
    };
    const outsideAnswers: any[] = [];
    const prisma: any = {
      ...tables('outside'),
      $transaction: async (work: any) => work(tx),
      appointmentRequest: {
        findUnique: async () => request,
        update: async ({ data }: any) => {
          events.push('outside:answer-request');
          outsideAnswers.push(data);
          return { ...request, ...data };
        },
      },
    };

    const told: any[] = [];
    const notifications: any = {
      notifyRefundDueAfterCancellation: async (...args: any[]) => {
        events.push('notice');
        told.push(args);

        if (options.noticeFails) throw new Error('the notice could not be sent');
      },
    };

    return {
      service: new SchedulingService(prisma, {} as any, notifications),
      told,
      statusWrites,
      timeline,
      deleted,
      created,
      moves,
      cancels,
      jobWrites,
      approvals,
      rejections,
      siblings,
      outsideAnswers,
      events,
      locks,
      queries,
      reads,
    };
  }

  const review = (w: ReturnType<typeof makeReview>, approved = true) =>
    w.service.reviewAppointmentRequest(1, 'ADMIN' as any, 5, approved, { adminResponse: 'Ok' } as any);

  it('moves the appointment and makes the reminders again for the new time: day before and two hours before, for both', async () => {
    const w = makeReview();

    await review(w);

    expect(w.moves.length).toBe(1);
    expect(w.deleted.length).toBe(1);
    expect(w.deleted[0].where).toEqual({ appointmentId: 12, status: 'PENDING' });
    expect(w.created[0].data.length).toBe(4);
    expect(w.created[0].data.map((r: any) => r.minutesBefore).sort()).toEqual([120, 120, 1440, 1440]);
    expect(w.created[0].data.every((r: any) => r.appointmentId === 12)).toBe(true);
    expect(w.created[0].data.some((r: any) => r.recipientId === 4)).toBe(true);
    expect(w.created[0].data.some((r: any) => r.recipientId === 2)).toBe(true);
  });

  it('the visit is at its new time, planned and not confirmed: the artisan confirmed the old time, not this one', async () => {
    const w = makeReview({ appointmentStatus: 'RESCHEDULE_REQUESTED', previousStatus: 'CONFIRMED', confirmedAt: new Date('2099-10-01T08:00:00Z') });

    await review(w);

    expect(w.moves[0].status).toBe('SCHEDULED');
    expect(w.moves[0].confirmedAt).toBeNull();
    // nothing else waits, so the visit shows nothing more: no second write of its status
    expect(w.statusWrites).toEqual([]);
  });

  it('a request that still waits is told the visit is now scheduled (a refusal later must not give the new time a confirmation nobody gave)', async () => {
    const w = makeReview({ appointmentStatus: 'RESCHEDULE_REQUESTED', previousStatus: 'CONFIRMED' });

    await review(w);

    expect(w.siblings).toEqual([{ where: { appointmentId: 12, status: 'PENDING', id: { not: 5 } }, data: { previousStatus: 'SCHEDULED' } }]);
  });

  it('a cancellation asked meanwhile is still shown on the visit after the move', async () => {
    const w = makeReview({ appointmentStatus: 'CANCEL_REQUESTED', waiting: [{ id: 6, type: 'CANCEL', status: 'PENDING', previousStatus: 'CONFIRMED' }] });

    await review(w);

    expect(w.statusWrites).toEqual([{ status: 'CANCEL_REQUESTED' }]);
    expect(w.events.indexOf('tx:visit-status') > w.events.indexOf('tx:move')).toBe(true);
  });

  it('refuses a new time outside the weekly hours of the artisan, like the matching and the assignment would', async () => {
    const w = makeReview({ availability: [slot('TUESDAY', '08:00', '17:00')] });

    const error = await failure(review(w));

    expect(error instanceof BadRequestException).toBe(true);
    expect(w.moves).toEqual([]);
    expect(w.created).toEqual([]);
  });

  it('and one that overlaps another appointment of the artisan', async () => {
    const w = makeReview({ overlapping: [{ id: 99 }] });

    const error = await failure(review(w));

    expect(error instanceof BadRequestException).toBe(true);
    expect(w.moves).toEqual([]);
  });

  it('a refused time leaves the request pending: it is not marked approved', async () => {
    const w = makeReview({ overlapping: [{ id: 99 }] });

    await failure(review(w));

    expect(w.approvals).toEqual([]);
    expect(w.outsideAnswers).toEqual([]);
  });

  it('looks at the other appointments of the artisan, not at the one being moved', async () => {
    const w = makeReview();

    await review(w);

    expect(w.queries[0].where.id).toEqual({ not: 12 });
    expect(w.queries[0].where.artisanId).toBe(4);
  });

  it('looks at the calendar and moves the appointment through the transaction that holds the lock, not beside it', async () => {
    const w = makeReview();

    await review(w);

    expect(w.reads.length > 0).toBe(true);
    expect(w.reads.filter((where) => where === 'outside' || where === 'outside-write')).toEqual([]);
    expect(w.reads.includes('tx-write')).toBe(true);
  });

  it('takes the artisan\'s lock before it looks, so an assignment for the same hour waits', async () => {
    const w = makeReview();

    await review(w);

    const artisanLock = w.locks.find((lock) => lock.values[0] === 71002);

    expect(/pg_advisory_xact_lock\(/.test(artisanLock.sql)).toBe(true);
    expect(artisanLock.values).toEqual([71002, 4]);
    expect(artisanLock.movesSoFar).toBe(0); // taken before the appointment is written
    expect(w.queries.length).toBe(1);
  });

  it('locks the job first, then the artisan (the order an assignment uses), then reads the request again under the locks', async () => {
    const w = makeReview();

    await review(w);

    expect(w.events.slice(0, 3)).toEqual(['lock:71001,8', 'tx:read-request', 'lock:71002,4']);
    expect(w.events.indexOf('tx:move') > w.events.indexOf('tx:overlaps')).toBe(true);
  });

  it('makes the reminders again in the same transaction, after the move and before the request is answered', async () => {
    const w = makeReview();

    await review(w);

    const at = (event: string) => w.events.indexOf(event);

    expect(at('tx:reminders-deleted') > at('tx:move')).toBe(true);
    expect(at('tx:reminders-made') > at('tx:reminders-deleted')).toBe(true);
    expect(at('tx:answer-request') > at('tx:reminders-made')).toBe(true);
  });

  it('marks the request approved in the same transaction as the move, not after it', async () => {
    const w = makeReview();

    await review(w);

    expect(w.approvals.length).toBe(1);
    expect(w.approvals[0].status).toBe('APPROVED');
    expect(w.approvals[0].reviewedById).toBe(1);
    expect(w.approvals[0].adminResponse).toBe('Ok');
    expect(w.outsideAnswers).toEqual([]);
    expect(w.events.indexOf('tx:answer-request') > w.events.indexOf('tx:move')).toBe(true);
  });

  it('a request that was closed while this one waited for the lock (a hand-over cancels it) changes nothing', async () => {
    const w = makeReview({ fresh: { status: 'CANCELLED' } });

    const error = await failure(review(w));

    expect(error instanceof BadRequestException).toBe(true);
    expect(w.moves).toEqual([]);
    expect(w.approvals).toEqual([]);
    expect(w.created).toEqual([]);
    expect(w.deleted).toEqual([]);
  });

  it('the artisan is the one the appointment has now: the lock and the check are for them', async () => {
    const w = makeReview({ freshAppointment: { artisanId: 6 }, jobArtisanId: 6 });

    await review(w);

    expect(w.locks.find((lock) => lock.values[0] === 71002).values).toEqual([71002, 6]);
    expect(w.queries[0].where.artisanId).toBe(6);
  });

  it('an appointment that has no artisan any more cannot be moved', async () => {
    const w = makeReview({ freshAppointment: { artisanId: null } });

    const error = await failure(review(w));

    expect(error instanceof BadRequestException).toBe(true);
    expect(w.moves).toEqual([]);
    expect(w.approvals).toEqual([]);
  });

  describe('a request about a visit that is gone is not approved', () => {
    it('an appointment that was cancelled meanwhile (the other request of the same appointment was approved) is not moved back to life', async () => {
      const w = makeReview({ freshAppointment: { status: 'CANCELLED' } });

      const error = await failure(review(w));

      expect(error instanceof BadRequestException).toBe(true);
      expect(w.moves).toEqual([]);
      expect(w.approvals).toEqual([]);
      expect(w.created).toEqual([]);
    });

    it('a visit still in the name of an artisan who gave the job back (or lost it) is not moved or cancelled for the job of somebody else', async () => {
      for (const type of ['RESCHEDULE', 'CANCEL'] as const) {
        const w = makeReview({ type, jobArtisanId: 9 });

        const error = await failure(review(w));

        expect(error instanceof BadRequestException).toBe(true);
        expect(w.moves).toEqual([]);
        expect(w.jobWrites).toEqual([]);
        expect(w.approvals).toEqual([]);
      }
    });

    it('a job with no artisan at all is the same', async () => {
      const w = makeReview({ jobArtisanId: null });

      const error = await failure(review(w));

      expect(error instanceof BadRequestException).toBe(true);
      expect(w.moves).toEqual([]);
    });

    it('a visit in nobody\'s name on a job nobody has cannot be cancelled either (two nulls are not "the same artisan")', async () => {
      const w = makeReview({ type: 'CANCEL', freshAppointment: { artisanId: null }, jobArtisanId: null });

      const error = await failure(review(w));

      expect(error instanceof BadRequestException).toBe(true);
      expect(w.jobWrites).toEqual([]);
      expect(w.cancels).toEqual([]);
    });

    it('a job that is no longer under way (back to waiting, finished, cancelled): 409, nothing moves', async () => {
      for (const jobStatus of ['WAITING_ADMIN_REVIEW', 'COMPLETED', 'CANCELLED']) {
        const w = makeReview({ jobStatus });

        const error = await failure(review(w));

        expect(error.getStatus()).toBe(409);
        expect(w.moves).toEqual([]);
        expect(w.approvals).toEqual([]);
      }
    });

    it('a job that is under way, in either spelling of accepted, can have its visit moved', async () => {
      for (const jobStatus of ['ASSIGNED', 'ARTISAN_ACCEPTED', 'ACCEPTED']) {
        const w = makeReview({ jobStatus });

        await review(w);

        expect(w.moves.length).toBe(1);
      }
    });

    it('but a request can still be refused whatever became of the visit', async () => {
      const w = makeReview({ freshAppointment: { status: 'CANCELLED' }, jobArtisanId: null });

      await review(w, false);

      expect(w.rejections.length).toBe(1);
    });
  });

  describe('a request to cancel', () => {
    it('cancels the job and the appointment and marks the request approved, all in one transaction under the job lock', async () => {
      const w = makeReview({ type: 'CANCEL' });

      await review(w);

      expect(w.events.slice(0, 2)).toEqual(['lock:71001,8', 'tx:read-request']);
      expect(w.jobWrites.length).toBe(1);
      expect(w.jobWrites[0].status).toBe('CANCELLED');
      expect(w.cancels.length).toBe(1);
      expect(w.cancels[0].cancelReason).toBe('Empêchement');
      expect(w.approvals.length).toBe(1);
      expect(w.outsideAnswers).toEqual([]);
      expect(w.events.indexOf('tx:answer-request') > w.events.indexOf('tx:cancel-appointment')).toBe(true);
    });

    it('closes the other waiting requests of that appointment, and the reminders not sent yet go with the visit', async () => {
      const w = makeReview({ type: 'CANCEL' });

      await review(w);

      expect(w.siblings.length).toBe(1);
      expect(w.siblings[0].where).toEqual({ appointmentId: 12, status: 'PENDING', id: { not: 5 } });
      expect(w.siblings[0].data.status).toBe('CANCELLED');
      expect(w.siblings[0].data.reviewedById).toBe(1);
      expect(w.deleted).toEqual([{ where: { appointmentId: 12, status: 'PENDING' } }]);
      expect(w.created).toEqual([]);
    });

    it('a request closed while it waited for the lock cancels nothing', async () => {
      const w = makeReview({ type: 'CANCEL', fresh: { status: 'CANCELLED' } });

      const error = await failure(review(w));

      expect(error instanceof BadRequestException).toBe(true);
      expect(w.jobWrites).toEqual([]);
      expect(w.cancels).toEqual([]);
      expect(w.approvals).toEqual([]);
    });

    it('a job that is already done cannot be cancelled: the request stays pending', async () => {
      const w = makeReview({ type: 'CANCEL', jobStatus: 'COMPLETED' });

      const error = await failure(review(w));

      expect(error !== undefined).toBe(true);
      expect(w.cancels).toEqual([]);
      expect(w.approvals).toEqual([]);
    });

    const PAID_90 = { id: 1, status: 'PAID', amount: '90.000', amountRefunded: '0', currency: 'TND' };

    it('a job that holds money: the line for the back office is written in the same transaction, and the people who handle money are told only once it is written', async () => {
      const w = makeReview({ type: 'CANCEL', payments: [PAID_90] });

      await review(w);

      expect(w.timeline.map((line) => line.title)).toEqual(['Annulation approuvée', 'Remboursement à décider']);
      expect(w.timeline[1].metadata).toEqual({ internal: true, refundDue: 90 });
      expect(w.timeline[1].createdById).toBe(1);
      expect(w.jobWrites[0].cancelledById).toBe(1);
      expect(w.events.indexOf('tx:timeline') < w.events.indexOf('tx:answer-request')).toBe(true);
      expect(w.told).toEqual([[8, 90, 1]]);
      expect(w.events.indexOf('notice') > w.events.indexOf('tx:answer-request')).toBe(true);
      expect(w.events[w.events.length - 1]).toBe('notice');
    });

    it('a notice that cannot be sent does not undo the cancellation', async () => {
      const w = makeReview({ type: 'CANCEL', payments: [PAID_90], noticeFails: true });

      await review(w);

      expect(w.told).toHaveLength(1);
      expect(w.approvals).toHaveLength(1);
      expect(w.cancels).toHaveLength(1);
    });

    it('a job that holds nothing: only the cancellation is written, and nobody is told', async () => {
      const w = makeReview({ type: 'CANCEL', payments: [] });

      await review(w);

      expect(w.timeline.map((line) => line.title)).toEqual(['Annulation approuvée']);
      expect(w.told).toEqual([]);
      expect(w.events).not.toContain('notice');
    });

    it('a payment that went back in full holds nothing either', async () => {
      const w = makeReview({ type: 'CANCEL', payments: [{ ...PAID_90, status: 'REFUNDED', amountRefunded: '90.000' }] });

      await review(w);

      expect(w.timeline).toHaveLength(1);
      expect(w.told).toEqual([]);
    });

    it('a standing invoice that asks for all of it leaves nothing to give back: a line about the invoice, no notice', async () => {
      const w = makeReview({ type: 'CANCEL', payments: [PAID_90], invoices: [{ id: 3, status: 'ISSUED', invoiceNumber: 'F-2026-0007', amountTTC: '90.000', creditedAmount: '0', stampDuty: '0', currency: 'TND' }] });

      await review(w);

      expect(w.timeline.map((line) => line.title)).toEqual(['Annulation approuvée', 'Facture à annuler ou à créditer']);
      expect(w.timeline[1].message).toContain('F-2026-0007');
      expect(w.timeline[1].metadata).toEqual({ internal: true, invoiceStanding: 'F-2026-0007' });
      expect(w.told).toEqual([]);
    });

    it('an invoice that asks for less than was paid: what is left is what is told, less the invoice', async () => {
      const w = makeReview({ type: 'CANCEL', payments: [PAID_90], invoices: [{ id: 3, status: 'ISSUED', invoiceNumber: 'F-2026-0007', amountTTC: '30.000', creditedAmount: '0', stampDuty: '0', currency: 'TND' }] });

      await review(w);

      expect(w.timeline.map((line) => line.title)).toEqual(['Annulation approuvée', 'Remboursement à décider']);
      expect(w.timeline[1].metadata).toEqual({ internal: true, refundDue: 60 });
      expect(w.told).toEqual([[8, 60, 1]]);
    });

    it('an invoice stands but nothing was paid: there is nothing to say about money', async () => {
      const w = makeReview({ type: 'CANCEL', payments: [], invoices: [{ id: 3, status: 'ISSUED', invoiceNumber: 'F-2026-0007', amountTTC: '90.000', creditedAmount: '0', stampDuty: '0', currency: 'TND' }] });

      await review(w);

      expect(w.timeline.map((line) => line.title)).toEqual(['Annulation approuvée']);
      expect(w.told).toEqual([]);
    });

    it('an invoice that asks for more than was paid leaves nothing to give back: a line about the invoice, no notice', async () => {
      const w = makeReview({ type: 'CANCEL', payments: [PAID_90], invoices: [{ id: 3, status: 'ISSUED', invoiceNumber: 'F-2026-0007', amountTTC: '150.000', creditedAmount: '0', stampDuty: '0', currency: 'TND' }] });

      await review(w);

      expect(w.timeline.map((line) => line.title)).toEqual(['Annulation approuvée', 'Facture à annuler ou à créditer']);
      expect(w.told).toEqual([]);
    });

    it('a cancelled invoice and a draft ask nothing of the customer', async () => {
      const w = makeReview({
        type: 'CANCEL',
        payments: [PAID_90],
        invoices: [
          { id: 3, status: 'CANCELLED', invoiceNumber: 'F-1', amountTTC: '90.000', creditedAmount: '0', currency: 'TND' },
          { id: 4, status: 'DRAFT', invoiceNumber: 'F-2', amountTTC: '90.000', creditedAmount: '0', currency: 'TND' },
        ],
      });

      await review(w);

      expect(w.told).toEqual([[8, 90, 1]]);
    });

    it('a refused cancellation writes no line and tells nobody, whatever the job holds', async () => {
      const w = makeReview({ type: 'CANCEL', payments: [PAID_90], appointmentStatus: 'CANCEL_REQUESTED' });

      await review(w, false);

      expect(w.timeline).toEqual([]);
      expect(w.told).toEqual([]);
      expect(w.jobWrites).toEqual([]);
    });
  });

  describe('refusing a request', () => {
    it('is answered under the job lock, from what the request says now', async () => {
      const w = makeReview();

      await review(w, false);

      expect(w.events.slice(0, 2)).toEqual(['lock:71001,8', 'tx:read-request']);
      expect(w.rejections.length).toBe(1);
      expect(w.rejections[0].status).toBe('REJECTED');
      expect(w.rejections[0].reviewedById).toBe(1);
      expect(w.outsideAnswers).toEqual([]);
      expect(w.moves).toEqual([]);
    });

    it('does not turn a request that a hand-over closed into a refused one', async () => {
      const w = makeReview({ fresh: { status: 'CANCELLED' } });

      const error = await failure(review(w, false));

      expect(error instanceof BadRequestException).toBe(true);
      expect(w.rejections).toEqual([]);
    });

    it('puts the visit back to what it was before the request, in the same transaction as the answer: a confirmed visit stays confirmed', async () => {
      const w = makeReview({ appointmentStatus: 'RESCHEDULE_REQUESTED', previousStatus: 'CONFIRMED' });

      await review(w, false);

      expect(w.statusWrites).toEqual([{ status: 'CONFIRMED' }]);
      expect(w.events.indexOf('tx:visit-status') > w.events.indexOf('tx:answer-request')).toBe(true);
      expect(w.events.indexOf('outside:visit-status')).toBe(-1);
    });

    it('a visit that was only scheduled goes back to scheduled', async () => {
      const w = makeReview({ appointmentStatus: 'CANCEL_REQUESTED', type: 'CANCEL', previousStatus: 'SCHEDULED' });

      await review(w, false);

      expect(w.statusWrites).toEqual([{ status: 'SCHEDULED' }]);
    });

    it('another request still waits: the visit shows that one, and goes back only when none waits', async () => {
      const w = makeReview({
        appointmentStatus: 'RESCHEDULE_REQUESTED',
        previousStatus: 'CONFIRMED',
        waiting: [{ id: 6, type: 'CANCEL', status: 'PENDING', previousStatus: 'CONFIRMED' }],
      });

      await review(w, false);

      expect(w.statusWrites).toEqual([{ status: 'CANCEL_REQUESTED' }]);
    });

    it('a request made before the state was kept (nothing stored): a visit the artisan confirmed goes back to confirmed, the others to scheduled', async () => {
      const confirmed = makeReview({ appointmentStatus: 'RESCHEDULE_REQUESTED', previousStatus: null, confirmedAt: new Date('2099-10-01T08:00:00Z') });
      const plain = makeReview({ appointmentStatus: 'RESCHEDULE_REQUESTED', previousStatus: null, confirmedAt: null });

      await review(confirmed, false);
      await review(plain, false);

      expect(confirmed.statusWrites).toEqual([{ status: 'CONFIRMED' }]);
      expect(plain.statusWrites).toEqual([{ status: 'SCHEDULED' }]);
    });

    it('a visit that does not show a request any more is not written again', async () => {
      const w = makeReview({ appointmentStatus: 'SCHEDULED' });

      await review(w, false);

      expect(w.statusWrites).toEqual([]);
    });
  });
});

describe('an artisan blocking some time (same lock, same rule)', () => {
  function makeBlocks(options: { overlapping?: any[]; blocks?: any[] } = {}) {
    const created: any[] = [];
    const locks: any[] = [];
    const reads: string[] = [];

    const tables = (where: string) => ({
      artisanProfile: {
        findUnique: async () => {
          reads.push(where);
          return { userId: 4, availability: [] };
        },
      },
      appointment: {
        findMany: async () => {
          reads.push(where);
          return options.overlapping ?? [];
        },
      },
      artisanTimeBlock: {
        findMany: async () => {
          reads.push(where);
          return options.blocks ?? [];
        },
        create: async ({ data }: any) => {
          reads.push(`${where}-write`);
          created.push(data);
          return { id: 1, ...data };
        },
      },
    });

    const tx: any = {
      ...tables('tx'),
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        locks.push({ sql: strings.join('?'), values, createdSoFar: created.length });
        return 1;
      },
    };
    const prisma: any = { ...tables('outside'), $transaction: async (work: any) => work(tx) };

    return { service: new SchedulingService(prisma, {} as any, {} as any), created, locks, reads };
  }

  const dto: any = { startsAt: '2099-10-19T08:00:00.000Z', endsAt: '2099-10-19T09:00:00.000Z', reason: 'Dentiste' };

  it('writes the block under the lock, taken before it is written', async () => {
    const w = makeBlocks();

    await w.service.createTimeBlock(4, 'ARTISAN' as any, dto);

    expect(w.created.length).toBe(1);
    expect(w.created[0].artisanId).toBe(4);
    expect(w.locks.length).toBe(1);
    expect(w.locks[0].values).toEqual([71002, 4]);
    expect(w.locks[0].createdSoFar).toBe(0);
  });

  it('looks and writes through the transaction that holds the lock, not beside it', async () => {
    const w = makeBlocks();

    await w.service.createTimeBlock(4, 'ARTISAN' as any, dto);

    expect(w.reads.filter((where) => where.startsWith('outside'))).toEqual([]);
    expect(w.reads.includes('tx-write')).toBe(true);
  });

  it('refuses a block over a planned appointment: nothing is written', async () => {
    const w = makeBlocks({ overlapping: [{ id: 99 }] });

    const error = await failure(w.service.createTimeBlock(4, 'ARTISAN' as any, dto));

    expect(error instanceof BadRequestException).toBe(true);
    expect(w.created).toEqual([]);
  });
});

describe('changing a slot of the weekly hours by its id', () => {
  function makeSlots() {
    const slots = [
      { id: 10, artisanProfileId: 1, dayOfWeek: 'MONDAY', startTime: '08:00', endTime: '17:00', isAvailable: true },
      { id: 20, artisanProfileId: 2, dayOfWeek: 'MONDAY', startTime: '08:00', endTime: '17:00', isAvailable: true },
    ];
    const prisma: any = {
      artisanProfile: { findUnique: async ({ where }: any) => (where.userId === 4 ? { id: 1, userId: 4 } : null) },
      artisanAvailabilitySlot: {
        findFirst: async ({ where }: any) => slots.find((slot) => slot.id === where.id && slot.artisanProfileId === where.artisanProfileId) ?? null,
        update: async ({ where, data }: any) => Object.assign(slots.find((slot) => slot.id === where.id)!, data),
        create: async ({ data }: any) => ({ id: 30, ...data }),
      },
    };

    return { service: new SchedulingService(prisma, {} as any, {} as any), slots };
  }

  const dto = (slotId?: number): any => ({ slotId, dayOfWeek: 'TUESDAY', startTime: '09:00', endTime: '12:00' });

  it('changes a slot of the artisan\'s own schedule', async () => {
    const w = makeSlots();

    await w.service.upsertAvailabilitySlot(4, 'ARTISAN' as any, dto(10));

    expect(w.slots[0].dayOfWeek).toBe('TUESDAY');
    expect(w.slots[0].startTime).toBe('09:00');
  });

  it('does not change the slot of another artisan: not found, and that schedule is untouched', async () => {
    const w = makeSlots();

    const error = await failure(w.service.upsertAvailabilitySlot(4, 'ARTISAN' as any, dto(20)));

    expect(error instanceof NotFoundException).toBe(true);
    expect(w.slots[1].dayOfWeek).toBe('MONDAY');
  });

  it('a slot without an id is added to the artisan\'s own schedule', async () => {
    const w = makeSlots();

    const created = await w.service.upsertAvailabilitySlot(4, 'ARTISAN' as any, dto());

    expect(created.artisanProfileId).toBe(1);
  });
});
