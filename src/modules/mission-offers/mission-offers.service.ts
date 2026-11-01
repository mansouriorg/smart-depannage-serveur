import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { ArtisanVerificationStatus, Role } from '../../../generated/prisma/client';
import { distanceKm } from '../../common/geo/distance';
import {
  MAX_OFFERS_LISTED,
  becauseOf,
  closureReason,
  isLiveOffer,
  isOfferable,
  offerExpiry,
  offerRequest,
  offerView,
  recentSince,
} from '../../common/offers/offer-rules';
import { interventionForBoard } from '../../common/views/views';
import { PrismaService } from '../../prisma/prisma.service';
import { isCurrentVisit } from '../assignment/artisan-availability';
import { lockJob } from '../assignment/artisan-lock';
import { MatchingService } from '../matching/matching.service';
import { describeError } from '../notifications/delivery/delivery-error';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeService } from '../realtime/realtime.service';
import { liveOffersOf, withdrawOffers } from './offers-tx';

/** How many of the best matches are looked at to fill a round once those who were already asked are left out. */
const MATCH_POOL = 60;

/** The most offers one sweep settles, so that a backlog (the server was down) is worked off over a few minutes, not in one long transaction. */
const SWEEP_BATCH = 500;

const NOT_OPEN = 'Cette mission n’est pas ouverte: elle ne peut pas être proposée.';
const FIXED_VISIT = 'Un rendez-vous est déjà fixé pour cette mission: confiez-la directement à un artisan.';
const ROUND_OPEN = 'Des offres sont déjà en cours pour cette mission. Attendez leur fin ou retirez-les.';
const NOBODY = 'Aucun artisan disponible ne correspond à cette mission, ou tous ont déjà reçu une offre.';
// The bounds are those of MIN/MAX_OFFER_COUNT and MIN/MAX_OFFER_MINUTES (a test reads the sentences against them).
const BAD_COUNT = 'Le nombre d’artisans doit être compris entre 1 et 10.';
const BAD_MINUTES = 'La durée de l’offre doit être comprise entre 1 et 120 minutes.';

const isRowId = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) > 0 && (value as number) <= 2_147_483_647;

/**
 * A job offered to several technicians at once (P3-07).
 *
 * The back office offers an open job to the best-matched technicians who are free for it (five unless it says otherwise) for a few minutes
 * (ten by default). Each of them gets a push and sees the offer in the app with its countdown. The first to accept gets the job; that is the one
 * accept of the mission actions, under the lock of the job, which also ends every other offer of the job in the same transaction, so "exactly one
 * gets it and the others see it withdrawn" does not depend on timing. While an offer is live the job is reserved for those it was offered to:
 * the board and the taking of a job by its number leave the other technicians out until the offers have ended; then the job is open to every
 * technician it fits, as before offers existed.
 *
 * What ends an offer: the technician's answer (accepted, declined), the clock (expired), the job going elsewhere (withdrawn: taken by another,
 * given by the back office, cancelled) or the back office calling the round off. A minute-by-minute sweep writes the ones that nobody was there
 * to write, and tells the back office when a round ended with nobody taking the job.
 */
@Injectable()
export class MissionOffersService {
  private readonly logger = new Logger(MissionOffersService.name);
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly matching: MatchingService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeService,
  ) {}

  // ==========================================================
  // The back office offers a job
  // ==========================================================

  async send(actor: { id: number; role: Role }, interventionId: number, body: { count?: unknown; minutes?: unknown } | null | undefined) {
    this.assertId(interventionId);

    const request = offerRequest(body);

    if (request.ok === false) throw new BadRequestException(request.field === 'count' ? BAD_COUNT : BAD_MINUTES);

    const job = await this.prisma.intervention.findUnique({ where: { id: interventionId }, select: { id: true, status: true, artisanId: true } });

    if (!job) throw new NotFoundException('Mission introuvable.');

    this.assertOfferable(job);

    const visit = await this.prisma.appointment.findUnique({ where: { interventionId } });

    // Taking a job with a visit still to come is refused to a technician (only the assignment checks the calendar), so an offer of it would be one nobody can accept.
    if (isCurrentVisit(visit)) throw new ConflictException(FIXED_VISIT);

    // The best matches who are free for the job (the same list and score as "assign the best"), then those who were already asked are left out.
    const found = await this.matching.findMatchingArtisansForIntervention(actor.id, actor.role, interventionId, {
      onlyAvailable: true,
      limit: MATCH_POOL,
    } as any);

    const earlier = await this.prisma.missionOffer.findMany({ where: { interventionId }, select: { artisanId: true } });
    const asked = new Set(earlier.map((row: { artisanId: number }) => row.artisanId));
    const chosen = found.matches.filter((match: any) => match.serviceFit && !asked.has(match.artisanId)).slice(0, request.count);

    if (!chosen.length) throw new BadRequestException(NOBODY);

    const now = new Date();
    const expiresAt = offerExpiry(now, request.minutes);

    const made = await this.prisma.$transaction(async (tx: any) => {
      // The same lock as the accept and the assignment: an offer is never made for a job that was taken a moment ago, and a technician's answer
      // cannot slip between the check below and the rows being written.
      await lockJob(tx, interventionId);

      const current = await tx.intervention.findUnique({ where: { id: interventionId }, select: { id: true, status: true, artisanId: true } });

      if (!current) throw new NotFoundException('Mission introuvable.');

      this.assertOfferable(current);

      if ((await liveOffersOf(tx, interventionId, now)).length) throw new ConflictException(ROUND_OPEN);

      // What is still PENDING here is a round that ran out and was not written down yet.
      await tx.missionOffer.updateMany({ where: { interventionId, status: 'PENDING' }, data: { status: 'EXPIRED', respondedAt: now } });

      const before: Array<{ artisanId: number; round: number }> = await tx.missionOffer.findMany({
        where: { interventionId },
        select: { artisanId: true, round: true },
      });

      const alreadyAsked = new Set(before.map((row) => row.artisanId));
      const round = before.reduce((highest, row) => Math.max(highest, row.round), 0) + 1;
      const rows: any[] = [];

      for (const match of chosen) {
        if (alreadyAsked.has(match.artisanId)) continue;

        rows.push(
          await tx.missionOffer.create({
            data: {
              interventionId,
              artisanId: match.artisanId,
              round,
              rank: rows.length + 1,
              score: Number.isFinite(match.score) ? Math.round(match.score) : null,
              status: 'PENDING',
              offeredAt: now,
              expiresAt,
              offeredById: actor.id,
            },
          }),
        );
      }

      if (!rows.length) throw new ConflictException(NOBODY);

      return { round, rows };
    });

    // Each push alone: a push provider that is down must not turn offers that were made into an error the dispatcher answers by offering again.
    for (const row of made.rows) {
      await this.attempt('notification', () =>
        this.notifications.notifyMissionOffered({ interventionId, artisanId: row.artisanId, offerId: row.id, expiresAt, actorId: actor.id }),
      );
    }

    const names = new Map<number, string>(chosen.map((match: any) => [match.artisanId, String(match.name ?? '')]));

    return {
      interventionId,
      round: made.round,
      expiresAt,
      asked: request.count,
      offered: made.rows.length,
      offers: made.rows.map((row: any) => ({
        id: row.id,
        artisanId: row.artisanId,
        name: names.get(row.artisanId) ?? '',
        rank: row.rank,
        score: row.score,
        expiresAt: row.expiresAt,
      })),
    };
  }

  // ==========================================================
  // The back office looks at the offers of a job, or calls them off
  // ==========================================================

  async listForJob(interventionId: number) {
    this.assertId(interventionId);

    const job = await this.prisma.intervention.findUnique({ where: { id: interventionId }, select: { id: true, status: true, artisanId: true } });

    if (!job) throw new NotFoundException('Mission introuvable.');

    const rows: any[] = await this.prisma.missionOffer.findMany({
      where: { interventionId },
      include: { artisan: { select: { id: true, name: true } } },
      orderBy: { offeredAt: 'asc' },
    });

    const now = new Date();

    return {
      interventionId,
      offers: rows
        .map((row) => ({
          ...offerView(row, job, now),
          artisanId: row.artisanId,
          name: row.artisan?.name ?? '',
          round: row.round,
          rank: row.rank,
          score: row.score,
        }))
        .sort((a, b) => a.round - b.round || a.rank - b.rank),
    };
  }

  async withdrawRound(actorId: number, interventionId: number) {
    this.assertId(interventionId);

    const now = new Date();

    const told = await this.prisma.$transaction(async (tx: any) => {
      await lockJob(tx, interventionId);

      const job = await tx.intervention.findUnique({ where: { id: interventionId }, select: { id: true } });

      if (!job) throw new NotFoundException('Mission introuvable.');

      return withdrawOffers(tx, { interventionId, reason: 'STAFF', now });
    });

    this.tell(told, interventionId, 'withdrawn', 'staff');

    return { interventionId, withdrawn: told.length, by: actorId };
  }

  // ==========================================================
  // The technician's offers
  // ==========================================================

  /**
   * The offers of the signed-in technician: the ones they can answer now first, then the ones that ended in the last day (so that "taken by another
   * technician" can be read, not just found missing). `now` is the server's clock: the phone counts down from the difference with its own.
   * A job is shown in full only while the offer is open; once it ended the technician is told what happened and nothing about the job but its trade.
   */
  async listMine(userId: number) {
    const profile = await this.prisma.artisanProfile.findUnique({ where: { userId }, select: { verificationStatus: true } });

    if (!profile) throw new NotFoundException('Profil artisan introuvable.');

    if (profile.verificationStatus !== ArtisanVerificationStatus.APPROVED) {
      throw new ForbiddenException('Votre profil artisan doit être approuvé pour effectuer cette action.');
    }

    const now = new Date();

    const rows: any[] = await this.prisma.missionOffer.findMany({
      where: { artisanId: userId, offeredAt: { gt: recentSince(now) } },
      orderBy: { offeredAt: 'desc' },
      take: MAX_OFFERS_LISTED,
    });

    const jobs: any[] = rows.length
      ? await this.prisma.intervention.findMany({
          where: { id: { in: rows.map((row) => row.interventionId) } },
          include: { client: { select: { name: true } }, subService: true },
        })
      : [];

    const byId = new Map<number, any>(jobs.map((job) => [job.id, job]));
    const me = await this.prisma.user.findUnique({ where: { id: userId }, select: { latitude: true, longitude: true } });

    const offers = rows.map((row) => {
      const job = byId.get(row.interventionId) ?? null;
      const view = offerView(row, job, now);

      if (view.state !== 'open' || !job) {
        // Nothing of the job once the offer is over, but the trade: the card says what it was.
        return { ...view, job: job ? { id: job.id, serviceType: job.serviceType } : null };
      }

      const away =
        me?.latitude != null && me?.longitude != null && job.latitude != null && job.longitude != null
          ? Math.round(distanceKm(me.latitude, me.longitude, job.latitude, job.longitude) * 10) / 10
          : null;

      return { ...view, job: { ...interventionForBoard(job), distanceKm: away } };
    });

    // The open ones first (the soonest to run out at the top), then the rest by how recent they are.
    const open = offers.filter((offer) => offer.state === 'open').sort((a, b) => new Date(a.expiresAt as any).getTime() - new Date(b.expiresAt as any).getTime());
    const rest = offers.filter((offer) => offer.state !== 'open');

    return { now, offers: [...open, ...rest] };
  }

  // ==========================================================
  // The sweep
  // ==========================================================

  /** What the scheduler calls (it hands its callback an argument of its own, which must never be taken for a date). */
  @Cron('* * * * *')
  async run(): Promise<void> {
    await this.sweep(new Date());
  }

  /**
   * Writes down the ends nobody was there to write: offers whose time ran out (expired), and offers of a job that is no longer open (withdrawn:
   * taken by a technician through a route that ends offers itself, or cancelled). When the last live offer of a job ran out and the job is still
   * open, the back office is told. An answer given at the same moment wins: every write here is "only if still waiting".
   */
  async sweep(now: Date): Promise<{ expired: number; withdrawn: number }> {
    if (this.sweeping) return { expired: 0, withdrawn: 0 };

    this.sweeping = true;

    try {
      const expired = await this.expireLapsed(now);
      const withdrawn = await this.withdrawFromClosedJobs(now);

      return { expired, withdrawn };
    } catch (error) {
      this.logger.error(`The sweep of the offers failed (${describeError(error)}); the next minute tries again.`);

      return { expired: 0, withdrawn: 0 };
    } finally {
      this.sweeping = false;
    }
  }

  private async expireLapsed(now: Date): Promise<number> {
    const lapsed: any[] = await this.prisma.missionOffer.findMany({
      where: { status: 'PENDING', expiresAt: { lte: now } },
      orderBy: { expiresAt: 'asc' },
      take: SWEEP_BATCH,
      select: { id: true, interventionId: true, artisanId: true },
    });

    if (!lapsed.length) return 0;

    const done: any[] = [];

    try {
      for (const offer of lapsed) {
        const changed = await this.prisma.missionOffer.updateMany({
          where: { id: offer.id, status: 'PENDING', expiresAt: { lte: now } },
          data: { status: 'EXPIRED', respondedAt: now },
        });

        if (changed.count > 0) done.push(offer);
      }
    } finally {
      // Whatever was written is told, even when a later write failed: those rows are no longer waiting, so no later sweep would find them.
      for (const offer of done) this.tell([offer.artisanId], offer.interventionId, 'expired', null);

      await this.reportEndedRounds(
        [...new Set(done.map((offer) => offer.interventionId as number))],
        now,
      );
    }

    return done.length;
  }

  private async withdrawFromClosedJobs(now: Date): Promise<number> {
    const waiting: any[] = await this.prisma.missionOffer.findMany({
      where: { status: 'PENDING', expiresAt: { gt: now } },
      orderBy: { offeredAt: 'asc' },
      take: SWEEP_BATCH,
      select: { id: true, interventionId: true, artisanId: true },
    });

    if (!waiting.length) return 0;

    const jobs: any[] = await this.prisma.intervention.findMany({
      where: { id: { in: [...new Set(waiting.map((offer) => offer.interventionId as number))] } },
      select: { id: true, status: true, artisanId: true },
    });

    const byId = new Map<number, any>(jobs.map((job) => [job.id, job]));
    let count = 0;

    for (const offer of waiting) {
      const job = byId.get(offer.interventionId);

      // A job that is gone cannot be offered; a deleted job takes its offers with it, so this is only a job read a moment too early.
      if (!job || isOfferable(job)) continue;

      // The offered technician holds the job themselves (it reached them by a route that does not settle offers): their offer is the one that was taken up.
      if (job.artisanId === offer.artisanId && closureReason(job) === 'TAKEN') {
        await this.prisma.missionOffer.updateMany({ where: { id: offer.id, status: 'PENDING' }, data: { status: 'ACCEPTED', respondedAt: now } });

        continue;
      }

      const reason = closureReason(job);
      const changed = await this.prisma.missionOffer.updateMany({
        where: { id: offer.id, status: 'PENDING' },
        data: { status: 'WITHDRAWN', withdrawnReason: reason, respondedAt: now },
      });

      if (changed.count > 0) {
        count += 1;
        this.tell([offer.artisanId], offer.interventionId, 'withdrawn', becauseOf(reason));
      }
    }

    return count;
  }

  /** A job whose offers have all ended without anybody taking it and that is still open: the back office is told. */
  private async reportEndedRounds(interventionIds: number[], now: Date): Promise<void> {
    for (const interventionId of interventionIds) {
      // One job that cannot be read does not keep the others from being reported.
      try {
        const job = await this.prisma.intervention.findUnique({ where: { id: interventionId }, select: { id: true, status: true, artisanId: true } });

        if (!job || !isOfferable(job)) continue;

        const rows: any[] = await this.prisma.missionOffer.findMany({ where: { interventionId }, select: { status: true, expiresAt: true, round: true } });

        // Still waiting (live, or run out and not written yet because an earlier write failed): the round is not over, the next sweep reports it.
        if (rows.some((row) => String(row.status) === 'PENDING')) continue;

        const last = rows.reduce((highest, row) => Math.max(highest, row.round), 0);
        const offered = rows.filter((row) => row.round === last).length;

        await this.attempt('notification to the back office', () => this.notifications.notifyOfferRoundEnded({ interventionId, offered }));
      } catch (error) {
        this.logger.error(`The end of the offers of job ${interventionId} could not be reported to the back office (${describeError(error)}).`);
      }
    }
  }

  // ==========================================================
  // Helpers
  // ==========================================================

  private assertId(interventionId: number) {
    // A number the database cannot hold is no mission: a 404, not an error 500 from the lock.
    if (!isRowId(interventionId)) throw new NotFoundException('Mission introuvable.');
  }

  private assertOfferable(job: { status?: unknown }) {
    if (!isOfferable(job)) throw new ConflictException(NOT_OPEN);
  }

  /** The technicians' open apps learn that an offer is over; one failing does not stop the others. */
  private tell(userIds: number[], interventionId: number, status: 'withdrawn' | 'expired', because: string | null) {
    for (const userId of userIds) {
      try {
        this.realtime.emitOfferUpdate(userId, { interventionId, status, because });
      } catch (error) {
        this.logger.error(`After an offer ended, the live event failed (${describeError(error)}).`);
      }
    }
  }

  private async attempt(what: string, work: () => Promise<unknown>) {
    try {
      await work();
    } catch (error) {
      // Kind of error only: the details may hold a phone number or an address.
      this.logger.error(`After offers were made, the ${what} failed (${describeError(error)}).`);
    }
  }
}
