import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import {
  AppointmentStatus,
  ArtisanVerificationStatus,
  InterventionEventType,
  MissionRejectionReason,
  Status,
} from '../../../generated/prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { getBusinessTimeZone } from '../../config/env';
import { ROAD_MOMENTS_SELECT, whenDoneOnJob } from '../../common/time/queued-for';
import {
  ACTIVE_JOB_STATUSES,
  ISSUE_AT_MAXIMUM,
  ISSUE_NOT_ACCEPTING,
  ISSUE_NO_EMERGENCY,
  artisanAvailabilityIssues,
  isCurrentVisit,
} from '../assignment/artisan-availability';
import { closePendingRequests, detachAppointment } from '../assignment/appointment-release';
import { replaceDefaultReminders } from '../assignment/appointment-reminders';
import { lockArtisanCalendar, lockJob } from '../assignment/artisan-lock';
import { InterventionEventsService } from '../intervention-events/intervention-events.service';
import {
  CanonicalStatus,
  STATUS_GROUPS,
  canonicalStatus,
  checkTransition,
} from '../intervention-workflow/intervention-status';
import { transitionStatusDetailed } from '../intervention-workflow/transition-status';
import { withoutStaffFields } from '../interventions/intervention-redaction';
import { describeError } from '../notifications/delivery/delivery-error';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeService } from '../realtime/realtime.service';
import { OPEN_CANONICAL, isOpenJob } from './open-job';
import { MISFIT_MESSAGE, misfitOf } from '../artisans/job-fit';
import { reservedAgainst } from '../../common/offers/offer-rules';
import { declineOffer, liveOffersOf, settleOffersOnTake } from '../mission-offers/offers-tx';

/** The statuses an open job (nobody has it) or a job given to the artisan can be accepted from. */
const ACCEPTABLE: CanonicalStatus[] = ['CREATED', 'WAITING_ADMIN_REVIEW', 'QUOTE_ACCEPTED', 'ASSIGNED'];

/** The job is offered to other artisans for a few minutes (P3-07): nobody else can take it before the offers have ended. */
const RESERVED = 'Cette mission est proposée à d’autres artisans pour quelques minutes.';

/** The job is the artisan's but it is past the point where it can be given back. */
const CANNOT_GIVE_BACK =
  'Cette mission ne peut plus être rendue dans son état actuel. Signalez un problème pour que le support vous aide.';

/** What the artisan who comes second is told. */
const TAKEN = 'Cette mission vient d’être attribuée à un autre artisan ou n’est plus disponible.';

/** The statuses in which a job is in the hands of its artisan (from assigned to payment pending). */
const HELD: readonly CanonicalStatus[] = STATUS_GROUPS.active;

/** What an artisan who leaves a job no longer has: the dates of the steps they took. */
const LEFT_THE_JOB = {
  artisanId: null,
  assignedAt: null,
  artisanAcceptedAt: null,
  artisanOnTheWayAt: null,
  artisanArrivedAt: null,
};

/** The reasons that come from the profile, in words for the artisan (the matching words them for a dispatcher). */
const ISSUES_FOR_THE_ARTISAN: Record<string, string> = {
  [ISSUE_NOT_ACCEPTING]:
    'Vous n’acceptez pas de missions pour le moment: activez votre disponibilité dans votre profil.',
  [ISSUE_NO_EMERGENCY]:
    'Cette mission est une urgence et votre profil n’est pas disponible pour les urgences.',
  [ISSUE_AT_MAXIMUM]: 'Vous avez atteint votre nombre maximum de missions actives.',
};

/** Where a refused job goes: back to the dispatcher queue (the spelling the dashboard reads). */
const QUEUE_STATUS = Status.ADMIN_REVIEW;

/** The reasons an artisan can give, written for the back office. */
export const REFUSAL_REASON_LABELS: Record<MissionRejectionReason, string> = {
  NOT_AVAILABLE: 'pas disponible',
  TOO_FAR: 'trop loin',
  OUT_OF_SPECIALTY: 'hors de sa spécialité',
  PRICE_TOO_LOW: 'prix trop bas',
  OTHER: 'autre motif',
};

/** Longest note of an artisan repeated in a notification. */
const NOTE_IN_NOTIFICATION = 200;

const isRowId = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) > 0 && (value as number) <= 2_147_483_647;

export type MissionInput = {
  /** The artisan who acts (the logged-in user). */
  userId: number;
  interventionId: number;
  /** What the caller wants back on the mission. */
  include?: unknown;
  /** How long the phone held this action before it could send it, in seconds (header `X-Queued-For`, P3-06); 0 or missing when it did not. */
  queuedForSeconds?: number;
};

export type DeclineInput = MissionInput & {
  reason: MissionRejectionReason;
  note?: string | null;
};

type StepName = 'on-the-way' | 'arrived';

/** What each step writes, from where it may be taken, and what to say when it may not. */
const STEPS: Record<
  StepName,
  {
    to: Status;
    target: CanonicalStatus;
    column: string;
    eventType: InterventionEventType;
    title: string;
    message: string;
    explain: (current: CanonicalStatus | null) => string;
  }
> = {
  'on-the-way': {
    to: Status.ON_THE_WAY,
    target: 'ARTISAN_ON_THE_WAY',
    column: 'artisanOnTheWayAt',
    eventType: InterventionEventType.ARTISAN_ON_THE_WAY,
    title: 'Artisan en route',
    message: 'L’artisan est en route vers l’adresse.',
    explain: (current) =>
      current === 'ASSIGNED'
        ? 'Acceptez d’abord la mission avant de partir.'
        : 'Cette action n’est plus possible dans l’état actuel de la mission.',
  },
  arrived: {
    to: Status.ARRIVED,
    target: 'ARTISAN_ARRIVED',
    column: 'artisanArrivedAt',
    eventType: InterventionEventType.ARTISAN_ARRIVED,
    title: 'Artisan arrivé',
    message: 'L’artisan est arrivé sur place.',
    explain: (current) =>
      current === 'ASSIGNED' || current === 'ARTISAN_ACCEPTED'
        ? 'Indiquez d’abord que vous êtes en route.'
        : 'Cette action n’est plus possible dans l’état actuel de la mission.',
  },
};

/**
 * What an artisan does with a mission (P1-06): accept it, give it back, say they are on the
 * way, say they have arrived. Every status change goes through `transitionStatusDetailed`
 * (the table of P1-01 decides what is legal), and each action:
 *
 *  - changes the status ONCE: it runs under the lock of the job (the same lock as the
 *    assignment), and an action that is already done (a double tap, an answer lost on a bad
 *    network and sent again) answers with the mission as it is, writes nothing and tells nobody;
 *  - tells the client and the back office, writes a line in the timeline and sends the live
 *    event. Those come after the commit and each one alone: a SMS provider that is down must
 *    not turn an action that was made into an error the artisan answers by doing it again.
 *
 * Giving a mission back puts the job in the dispatcher queue: the artisan is taken off the job,
 * the visit planned for them is released (nobody's name, its waiting requests closed, its
 * reminders dropped), and the refusal is remembered so the job is not offered to them again.
 */
@Injectable()
export class MissionActionsService {
  private readonly logger = new Logger(MissionActionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly events: InterventionEventsService,
    private readonly realtime: RealtimeService,
  ) {}

  // ==========================================================
  // Accept
  // ==========================================================

  async accept(input: MissionInput) {
    const { userId, interventionId, include } = input;

    this.assertId(interventionId);

    const profile = await this.approvedProfile(userId, true);

    const done = await this.prisma.$transaction(async (tx: any) => {
      // The same lock as the assignment: a dispatcher giving the job to somebody else, and the
      // artisan pressing "accept", cannot both win.
      await lockJob(tx, interventionId);

      // A job that is somebody else's: the answer of the artisan who lost the race (P0-10).
      const job = await this.jobOf(tx, userId, interventionId, 'taken');
      const status = canonicalStatus(job.status);
      // The artisan HAS the job when it is theirs and in the hands of an artisan. A job that
      // still carries their id after the back office took it back (it waits in the queue) is an
      // open job for them like for anybody else.
      const holds = this.holds(job, userId);

      if (holds && status === 'ARTISAN_ACCEPTED') {
        // Already accepted (a double tap, or a retry after a lost answer): nothing to do.
        return {
          row: await tx.intervention.findUnique({ where: { id: interventionId }, include }),
          changed: false,
          previousStatus: String(job.status),
          previousArtisanId: null as number | null,
          // Nothing was taken, so no offer ends (the early return of a repeated accept).
          withdrawn: [] as number[],
        };
      }

      if (!status || !ACCEPTABLE.includes(status)) {
        throw new BadRequestException('Cette mission ne peut pas être acceptée.');
      }

      let visit: any = null;

      if (!holds) {
        // Taking an open job: the same rule as being given one (accepting missions, urgent
        // jobs, the maximum of active missions), checked under the artisan's lock so two
        // jobs taken at the same moment cannot both pass.
        await lockArtisanCalendar(tx, userId);

        // A job offered to several artisans (P3-07) is theirs to take while their offers are live; anybody else waits for the offers to end.
        if (reservedAgainst(await liveOffersOf(tx, interventionId, new Date()), userId)) throw new ConflictException(RESERVED);

        visit = await tx.appointment.findUnique({ where: { interventionId } });

        await this.assertMayTake(tx, profile, job, visit);
      }

      const now = new Date();

      // P0-10: the claim is one compare-and-set UPDATE, so two artisans pressing "accept" on the
      // same open job cannot both succeed: the second gets a 409.
      const moved = await transitionStatusDetailed(tx, {
        id: interventionId,
        to: Status.ACCEPTED,
        actor: { kind: 'artisan', userId },
        // Nobody's, this artisan's, or the leftover id of an artisan the job was taken from (the
        // very id that was read above: another artisan getting it in between still loses).
        where: {
          OR: [
            { artisanId: null },
            { artisanId: userId },
            ...(job.artisanId && job.artisanId !== userId ? [{ artisanId: job.artisanId as number }] : []),
          ],
        },
        data: { artisanId: userId },
        // Taking a job starts it from the beginning: the dates of the road of an artisan who
        // had it before do not come with it.
        dataOnChange: {
          artisanAcceptedAt: now,
          ...(holds ? {} : { assignedAt: now, artisanOnTheWayAt: null, artisanArrivedAt: null }),
        },
        include,
        conflictMessage: TAKEN,
      });

      // A visit still in the name of another artisan (the job was taken from them by a route
      // that did not release it) does not come with the job.
      if (visit && visit.artisanId !== null && visit.artisanId !== userId) {
        await this.releaseVisit(tx, visit, 'Mission reprise par un autre artisan.');
      }

      // The job is this artisan's now: their offer (if they had one) is accepted and every other offer of the job ends, in the same transaction as
      // the claim, so exactly one of the artisans it was offered to gets it and the others find their offer withdrawn (P3-07).
      const withdrawn = moved.changed ? await settleOffersOnTake(tx, { interventionId, winnerId: userId, now }) : [];

      return {
        row: moved.row,
        changed: moved.changed,
        previousStatus: moved.previousStatus,
        // The artisan the job was taken from, who still sits in its live room.
        previousArtisanId: !holds && job.artisanId && job.artisanId !== userId ? (job.artisanId as number) : null,
        withdrawn,
      };
    });

    if (done.changed) {
      // The artisans whose offer ended because this one took the job learn it in their open app (the others find it in their list).
      for (const other of done.withdrawn) {
        await this.attempt('live event of a withdrawn offer', async () => {
          this.realtime.emitOfferUpdate(other, { interventionId, status: 'withdrawn', because: 'taken' });
        });
      }

      if (done.previousArtisanId) {
        const left = done.previousArtisanId;

        await this.attempt('removal of the previous artisan from the live room', async () => {
          this.realtime.removeFromJobRoom(left, interventionId);
        });
      }

      await this.after({
        interventionId,
        userId,
        previousStatus: done.previousStatus,
        newStatus: String(done.row?.status ?? Status.ACCEPTED),
        timeline: {
          type: InterventionEventType.ARTISAN_ACCEPTED,
          title: 'Mission acceptée',
          message: 'L’artisan a accepté la mission.',
        },
        notify: () => this.notifications.notifyArtisanAcceptedMission(interventionId, userId),
      });
    }

    return this.forTheArtisan(done.row);
  }

  // ==========================================================
  // On the way, arrived
  // ==========================================================

  onTheWay(input: MissionInput) {
    return this.advance('on-the-way', input);
  }

  arrived(input: MissionInput) {
    return this.advance('arrived', input);
  }

  private async advance(name: StepName, input: MissionInput) {
    const { userId, interventionId, include, queuedForSeconds } = input;
    const step = STEPS[name];

    this.assertId(interventionId);

    await this.approvedProfile(userId);

    const done = await this.prisma.$transaction(async (tx: any) => {
      await lockJob(tx, interventionId);

      const job = await this.jobOf(tx, userId, interventionId);

      // The step is for the artisan who HAS the job (an open job is not on the way to anybody).
      if (job.artisanId !== userId) {
        throw new ForbiddenException('Cette mission ne vous est pas attribuée.');
      }

      const current = canonicalStatus(job.status);
      const verdict = checkTransition(String(job.status), step.target, 'artisan');

      // Already there (a double tap): the table says "same" and nothing is written below.
      if (verdict.ok === false) {
        throw new ConflictException(step.explain(current));
      }

      const moved = await transitionStatusDetailed(tx, {
        id: interventionId,
        to: step.to,
        actor: { kind: 'artisan', userId },
        // The moment the artisan pressed the button, when the phone held the action until it had a signal (P3-06): never before the steps that
        // come before it on this job, never after now.
        dataOnChange: { [step.column]: whenDoneOnJob(new Date(), queuedForSeconds ?? 0, job) },
        include,
      });

      return { row: moved.row, changed: moved.changed, previousStatus: moved.previousStatus };
    });

    if (done.changed) {
      await this.after({
        interventionId,
        userId,
        previousStatus: done.previousStatus,
        newStatus: String(done.row?.status ?? step.to),
        timeline: { type: step.eventType, title: step.title, message: step.message },
        notify: () =>
          name === 'on-the-way'
            ? this.notifications.notifyArtisanOnTheWay(interventionId, userId)
            : this.notifications.notifyArtisanArrived(interventionId, userId),
      });
    }

    return this.forTheArtisan(done.row);
  }

  // ==========================================================
  // Decline
  // ==========================================================

  async decline(input: DeclineInput) {
    const { userId, interventionId } = input;

    this.assertId(interventionId);

    const profile = await this.approvedProfile(userId);

    const done = await this.prisma.$transaction(async (tx: any) => {
      await lockJob(tx, interventionId);

      let job: any;

      try {
        job = await this.jobOf(tx, userId, interventionId);
      } catch (error) {
        // Pressed twice, and somebody else has the job since the first time: it is given back
        // already, which is what the artisan asked for.
        if (error instanceof ForbiddenException && (await this.hasRefused(tx, profile.id, interventionId))) {
          return { returnedToQueue: false, leftTheJob: false, previousStatus: '', newStatus: '' };
        }

        throw error;
      }

      const holds = this.holds(job, userId);
      const now = new Date();

      if (holds) {
        // What the artisan may do from here is the table's answer: before the work starts, yes.
        const verdict = checkTransition(String(job.status), QUEUE_STATUS, 'artisan');

        if (verdict.ok === false) throw new ConflictException(CANNOT_GIVE_BACK);
      } else if (!OPEN_CANONICAL.includes(canonicalStatus(job.status) as CanonicalStatus)) {
        // Their own job, but closed (finished, cancelled): not something to give back either.
        throw new ConflictException(job.artisanId === userId ? CANNOT_GIVE_BACK : 'Cette mission n’est plus disponible.');
      } else if (!(await this.hasRefused(tx, profile.id, interventionId)) && reservedAgainst(await liveOffersOf(tx, interventionId, now), userId)) {
        // A job offered to others for a few minutes is not theirs to refuse either: the refusal would be written down against a job they never saw (P3-07).
        // (Somebody who has already refused it, a double tap or an answer lost on the way, is answered as before.)
        throw new ConflictException(RESERVED);
      }

      // Their offer of this job (if they had one) is declined with the job (P3-07).
      await declineOffer(tx, { interventionId, artisanId: userId, now });

      // One line per artisan and job, with the latest reason: a button pressed twice does not
      // pile up refusals.
      const before = await tx.artisanMissionRejection.findFirst({
        where: { artisanProfileId: profile.id, interventionId },
      });

      if (before) {
        await tx.artisanMissionRejection.update({
          where: { id: before.id },
          data: { reason: input.reason, note: input.note ?? null },
        });
      } else {
        await tx.artisanMissionRejection.create({
          data: {
            artisanProfileId: profile.id,
            interventionId,
            reason: input.reason,
            note: input.note ?? null,
          },
        });
      }

      const visit = await tx.appointment.findUnique({ where: { interventionId } });
      // The id of the artisan stays on a job that went back to the queue by another route.
      const leftover = !holds && job.artisanId === userId;
      let newStatus = String(job.status);
      let previousStatus = String(job.status);

      if (holds || leftover) {
        // Back to the dispatcher queue. The compare-and-set also checks that the job is still
        // this artisan's. The dates of the steps the artisan took are cleared with it: they
        // were about this artisan, and the next one starts from the beginning. (A job that
        // already waits in the queue keeps its status: only the id and the dates go.)
        const moved = await transitionStatusDetailed(tx, {
          id: interventionId,
          to: holds ? QUEUE_STATUS : String(job.status),
          actor: { kind: 'artisan', userId },
          data: { artisanRejectedAt: now, ...LEFT_THE_JOB },
        });

        previousStatus = moved.previousStatus;
        newStatus = String(moved.row?.status ?? (holds ? QUEUE_STATUS : newStatus));
      } else {
        // An open job nobody has: remember the refusal, nothing else moves.
        await tx.intervention.update({ where: { id: interventionId }, data: { artisanRejectedAt: now } });
      }

      // The visit planned for this artisan is not theirs any more.
      if (visit && visit.artisanId === userId) {
        await this.releaseVisit(tx, visit, 'L’artisan a rendu la mission.');
      }

      return {
        returnedToQueue: holds,
        leftTheJob: holds || leftover,
        previousStatus,
        newStatus,
      };
    });

    if (done.leftTheJob) {
      // Before anything is said about the job: what follows must not reach this artisan.
      await this.attempt('removal from the live room', async () => {
        this.realtime.removeFromJobRoom(userId, interventionId);
      });
    }

    if (done.returnedToQueue) {
      const reasonText = this.reasonText(input.reason, input.note);

      await this.after({
        interventionId,
        userId,
        previousStatus: done.previousStatus,
        newStatus: done.newStatus,
        // The timeline is read by the client: no reason, no note, and not who it was.
        anonymous: true,
        timeline: {
          type: InterventionEventType.STATUS_CHANGED,
          title: 'Artisan indisponible',
          message: 'L’artisan ne peut pas assurer la mission. Une nouvelle recherche est en cours.',
        },
        notify: () => this.notifications.notifyArtisanDeclined(interventionId, userId, reasonText),
      });
    }

    return { message: 'Mission refusée.', returnedToQueue: done.returnedToQueue };
  }

  // ==========================================================
  // Helpers
  // ==========================================================

  private assertId(interventionId: number) {
    // A number the database cannot hold is no mission: a 404, not an error 500 from the lock.
    if (!isRowId(interventionId)) throw new NotFoundException('Mission introuvable.');
  }

  /** The artisan's profile, approved. `withHours` also loads the weekly hours (to take an open job). */
  private async approvedProfile(userId: number, withHours = false) {
    const profile = await (this.prisma as any).artisanProfile.findUnique({
      where: { userId },
      // Taking an open job also reads the trades and the zones of the profile (P1-11).
      include: withHours ? { availability: true, serviceZones: true } : undefined,
    });

    if (!profile) {
      throw new NotFoundException('Profil artisan introuvable.');
    }

    if (profile.verificationStatus !== ArtisanVerificationStatus.APPROVED) {
      throw new ForbiddenException('Votre profil artisan doit être approuvé pour effectuer cette action.');
    }

    return profile;
  }

  /**
   * The artisan has the job: it is theirs and it is in the hands of an artisan. The id of an
   * artisan can stay on a job the back office took back (it waits in the queue); that is not
   * holding it.
   */
  private holds(job: { artisanId: number | null; status: unknown }, userId: number) {
    return job.artisanId === userId && HELD.includes(canonicalStatus(String(job.status)) as CanonicalStatus);
  }

  /**
   * The job, if it is the artisan's or open. A job that is somebody else's is a 403 ("not
   * yours"), or, for the artisan who presses "accept" a moment too late, the 409 of the race.
   */
  private async jobOf(tx: any, userId: number, interventionId: number, other: 'forbidden' | 'taken' = 'forbidden') {
    const job = await tx.intervention.findUnique({
      where: { id: interventionId },
      select: {
        id: true,
        status: true,
        artisanId: true,
        clientId: true,
        urgency: true,
        serviceType: true,
        latitude: true,
        longitude: true,
        // The earlier steps of the road: a step done offline is never dated before them (P3-06).
        ...ROAD_MOMENTS_SELECT,
      },
    });

    if (!job) {
      throw new NotFoundException('Mission introuvable.');
    }

    // The id of another artisan on a job that waits in the queue again is a leftover: the job is open.
    if (!isOpenJob(job) && job.artisanId !== userId) {
      if (other === 'taken') throw new ConflictException(TAKEN);

      throw new ForbiddenException('Cette mission ne vous est pas attribuée.');
    }

    return job;
  }

  private async hasRefused(tx: any, profileId: number, interventionId: number) {
    const found = await tx.artisanMissionRejection.findFirst({
      where: { artisanProfileId: profileId, interventionId },
      select: { id: true },
    });

    return Boolean(found);
  }

  /** The visit of a job is no longer the artisan's: nobody's name, its requests closed, its reminders dropped. */
  private async releaseVisit(tx: any, visit: any, why: string) {
    await detachAppointment(tx, visit, why);

    // A visit still to come that the artisan had confirmed is not confirmed by anybody now: the
    // next artisan confirms it (or the dispatcher moves it).
    // A confirmed visit with a request to move it waiting shows "reschedule requested"; its confirmation is the artisan's all the same,
    // and left in place it would show a confirmation with nobody to have given it (P3-01).
    const confirmed =
      visit.status === AppointmentStatus.CONFIRMED ||
      (visit.status === AppointmentStatus.RESCHEDULE_REQUESTED && Boolean(visit.confirmedAt));

    if (confirmed && isCurrentVisit(visit)) {
      await tx.appointment.update({
        where: { interventionId: visit.interventionId },
        data: { status: AppointmentStatus.SCHEDULED, confirmedAt: null },
      });
    }

    await closePendingRequests(tx, visit.id, { response: `Demande classée: ${why.charAt(0).toLowerCase()}${why.slice(1)}` });
    // Without a start time this only drops the reminders that were not sent yet.
    await replaceDefaultReminders(tx, { ...visit, startsAt: null });
  }

  /** What an artisan gets back: the row without the columns of the back office. */
  private forTheArtisan(row: any) {
    return row ? withoutStaffFields(row) : row;
  }

  /**
   * An open job is taken by an artisan who has not refused it, who is free for it, and for
   * which no time is already fixed. A job with a visit planned (the dispatcher gave it a time,
   * the artisan gave it back) goes through the dispatcher: the time must be checked against the
   * calendar of whoever takes it, and the visit must follow the job, which only the assignment does.
   */
  private async assertMayTake(
    tx: any,
    profile: any,
    job: { id: number; urgency: unknown; serviceType?: string | null; latitude?: number | null; longitude?: number | null },
    visit: any,
  ) {
    const refused = await tx.artisanMissionRejection.findFirst({
      where: { artisanProfileId: profile.id, interventionId: job.id },
    });

    if (refused) {
      throw new ForbiddenException(
        'Vous avez refusé cette mission. Le service client peut vous la confier à nouveau.',
      );
    }

    // The board lists only the jobs of the artisan's trades inside their zones; taking one by its
    // number is refused the same way (P1-11). A job the back office gives is not judged here.
    if (misfitOf(profile, job)) {
      throw new ForbiddenException(MISFIT_MESSAGE);
    }

    if (isCurrentVisit(visit)) {
      throw new ConflictException(
        'Un rendez-vous est déjà fixé pour cette mission: le service client doit vous la confier.',
      );
    }

    const activeJobsCount = await tx.intervention.count({
      where: { artisanId: profile.userId, status: { in: ACTIVE_JOB_STATUSES }, id: { not: job.id } },
    });

    const issues = artisanAvailabilityIssues({
      profile: {
        isAcceptingJobs: profile.isAcceptingJobs,
        emergencyAvailable: profile.emergencyAvailable,
        maxActiveJobs: profile.maxActiveJobs,
        availability: profile.availability ?? [],
      },
      activeJobsCount,
      overlappingAppointments: 0,
      overlappingTimeBlocks: 0,
      emergency: String(job.urgency) === 'EMERGENCY',
      timeZone: getBusinessTimeZone(),
    });

    if (issues.length) {
      throw new BadRequestException({
        message: 'Vous ne pouvez pas prendre cette mission pour le moment.',
        issues: issues.map((issue) => ISSUES_FOR_THE_ARTISAN[issue] ?? issue),
      });
    }
  }

  private reasonText(reason: MissionRejectionReason, note?: string | null) {
    const label = REFUSAL_REASON_LABELS[reason] ?? String(reason);
    const text = String(note ?? '').trim();

    if (!text) return label;

    return `${label}: ${text.length > NOTE_IN_NOTIFICATION ? `${text.slice(0, NOTE_IN_NOTIFICATION)}…` : text}`;
  }

  /**
   * What follows an action that was made: the timeline, the people to tell, the live event.
   * Each alone, and a failure is logged, never thrown (the action is committed).
   */
  private async after(params: {
    interventionId: number;
    userId: number;
    previousStatus: string;
    newStatus: string;
    timeline: { type: InterventionEventType; title: string; message: string };
    notify: () => Promise<unknown>;
    /** The line of the timeline is not signed (the client reads it and must not learn who the artisan was). */
    anonymous?: boolean;
  }) {
    const { interventionId, userId } = params;

    await this.attempt('timeline', () =>
      this.events.create({
        interventionId,
        type: params.timeline.type,
        title: params.timeline.title,
        message: params.timeline.message,
        createdById: params.anonymous ? undefined : userId,
      }),
    );

    await this.attempt('notification', params.notify);

    await this.attempt('live event', () =>
      this.realtime.emitStatusChange({
        interventionId,
        oldStatus: params.previousStatus,
        newStatus: params.newStatus,
        actorId: userId,
      }),
    );
  }

  private async attempt(what: string, work: () => Promise<unknown>) {
    try {
      await work();
    } catch (error) {
      // Kind of error only: the details may hold a phone number or an address.
      this.logger.error(`After a mission action, the ${what} failed (${describeError(error)}).`);
    }
  }
}
