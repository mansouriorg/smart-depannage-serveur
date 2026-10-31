import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import * as crypto from 'crypto';

import { PrismaService } from '../../prisma/prisma.service';

import { ChangeWorkflowStatusDto } from './dto/change-workflow-status.dto';
import { CreateTimelineEventDto } from './dto/create-timeline-event.dto';

import {
  StatusActor,
  actorKindFor,
  allowedNextStatuses,
  canonicalStatus,
} from './intervention-status';
import { transitionStatusDetailed } from './transition-status';
import { CANCEL_BY_STATUS } from './cancel-by-status';
import { eventsForParties } from '../../common/views/views';
import { MoneyInput, formatMoney, money } from '../../common/money/money';

import {
  InterventionEventType,
  Prisma,
  Role,
  Status,
} from '../../../generated/prisma/client';

type AuthenticatedUser = {
  id: number;
  role: Role;
};

@Injectable()
export class InterventionWorkflowService {
  constructor(private readonly prisma: PrismaService) {}

  // ==========================================================
  // 1. HELPERS
  // ==========================================================

  private hashToken(token: string): string {
    // A link that was not sent at all hashes like an empty one, which no job has: "not found", not a crash (P1-17).
    return crypto.createHash('sha256').update(String(token ?? '')).digest('hex');
  }

  private isAdminRole(role: Role): boolean {
    const adminRoles: Role[] = [
      Role.ADMIN,
      Role.SUPER_ADMIN,
      Role.SUPPORT,
      Role.DISPATCHER,
      Role.ACCOUNTANT,
    ];

    return adminRoles.includes(role);
  }

  private async getInterventionOrFail(interventionId: number) {
    const intervention = await this.prisma.intervention.findUnique({
      where: { id: interventionId },
      include: {
        client: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
          },
        },
        artisan: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
          },
        },
        subService: true,
        quotes: {
          include: {
            items: true,
          },
          orderBy: {
            createdAt: 'desc',
          },
        },
        payments: {
          orderBy: {
            createdAt: 'desc',
          },
        },
        invoices: true,
        review: true,
      },
    });

    if (!intervention) {
      throw new NotFoundException('Intervention introuvable.');
    }

    return intervention;
  }

  private async checkAccess(user: AuthenticatedUser, interventionId: number) {
    const intervention = await this.getInterventionOrFail(interventionId);

    const isAdmin = this.isAdminRole(user.role);
    const isClient = intervention.clientId === user.id;
    const isArtisan = intervention.artisanId === user.id;

    if (!isAdmin && !isClient && !isArtisan) {
      throw new ForbiddenException('Accès refusé à cette intervention.');
    }

    return intervention;
  }

  private async checkAdminAccess(user: AuthenticatedUser) {
    if (!this.isAdminRole(user.role)) {
      throw new ForbiddenException('Action réservée à l’administration.');
    }
  }

  private eventTitleForStatus(status: Status): string {
    const titles: Partial<Record<Status, string>> = {
      [Status.CREATED]: 'Demande créée',
      [Status.WAITING_ADMIN_REVIEW]: 'En attente de validation admin',
      [Status.PENDING]: 'Demande en attente',
      [Status.ADMIN_REVIEW]: 'Analyse admin en cours',
      [Status.QUOTE_SENT]: 'Devis envoyé',
      [Status.QUOTE_ACCEPTED]: 'Devis accepté',
      [Status.ASSIGNED]: 'Artisan assigné',
      [Status.ARTISAN_ACCEPTED]: 'Mission acceptée par artisan',
      [Status.ACCEPTED]: 'Mission acceptée',
      [Status.ARTISAN_ON_THE_WAY]: 'Artisan en route',
      [Status.ON_THE_WAY]: 'Artisan en route',
      [Status.ARTISAN_ARRIVED]: 'Artisan arrivé',
      [Status.ARRIVED]: 'Artisan arrivé',
      [Status.IN_PROGRESS]: 'Intervention en cours',
      [Status.WAITING_CLIENT_VALIDATION]: 'En attente de validation client',
      [Status.COMPLETED]: 'Intervention terminée',
      [Status.PAYMENT_PENDING]: 'Paiement en attente',
      [Status.PAID]: 'Paiement confirmé',
      [Status.INVOICE_SENT]: 'Facture envoyée',
      [Status.INVOICE_READY]: 'Facture disponible',
      [Status.CANCELLED]: 'Intervention annulée',
      [Status.DISPUTED]: 'Litige ouvert',
    };

    return titles[status] || 'Statut mis à jour';
  }

  private eventTypeForStatus(status: Status): InterventionEventType {
    const types: Partial<Record<Status, InterventionEventType>> = {
      [Status.CREATED]: InterventionEventType.REQUEST_CREATED,
      [Status.WAITING_ADMIN_REVIEW]: InterventionEventType.ADMIN_REVIEWING,
      [Status.PENDING]: InterventionEventType.REQUEST_CREATED,
      [Status.ADMIN_REVIEW]: InterventionEventType.ADMIN_REVIEWING,
      [Status.QUOTE_SENT]: InterventionEventType.QUOTE_SENT,
      [Status.QUOTE_ACCEPTED]: InterventionEventType.QUOTE_ACCEPTED,
      [Status.ASSIGNED]: InterventionEventType.ARTISAN_ASSIGNED,
      [Status.ARTISAN_ACCEPTED]: InterventionEventType.ARTISAN_ACCEPTED,
      [Status.ACCEPTED]: InterventionEventType.ARTISAN_ACCEPTED,
      [Status.ARTISAN_ON_THE_WAY]: InterventionEventType.ARTISAN_ON_THE_WAY,
      [Status.ON_THE_WAY]: InterventionEventType.ARTISAN_ON_THE_WAY,
      [Status.ARTISAN_ARRIVED]: InterventionEventType.ARTISAN_ARRIVED,
      [Status.ARRIVED]: InterventionEventType.ARTISAN_ARRIVED,
      [Status.IN_PROGRESS]: InterventionEventType.WORK_STARTED,
      [Status.WAITING_CLIENT_VALIDATION]:
        InterventionEventType.CLIENT_VALIDATION_PENDING,
      [Status.COMPLETED]: InterventionEventType.WORK_COMPLETED,
      [Status.PAYMENT_PENDING]: InterventionEventType.PAYMENT_PENDING,
      [Status.PAID]: InterventionEventType.CLIENT_PAID,
      [Status.INVOICE_SENT]: InterventionEventType.INVOICE_SENT,
      [Status.INVOICE_READY]: InterventionEventType.INVOICE_READY,
      [Status.CANCELLED]: InterventionEventType.CANCELLED,
      [Status.DISPUTED]: InterventionEventType.ISSUE_REPORTED,
    };

    return types[status] || InterventionEventType.STATUS_CHANGED;
  }

  private statusTimestampData(status: Status): Prisma.InterventionUpdateInput {
    const now = new Date();

    switch (status) {
      case Status.CREATED:
      case Status.PENDING:
        return {
          requestCreatedAt: now,
        };

      case Status.WAITING_ADMIN_REVIEW:
      case Status.ADMIN_REVIEW:
        return {
          adminReviewStartedAt: now,
        };

      case Status.QUOTE_SENT:
        return {
          quoteSentAt: now,
        };

      case Status.QUOTE_ACCEPTED:
        return {
          quoteAcceptedAt: now,
        };

      case Status.ASSIGNED:
        return {
          assignedAt: now,
        };

      case Status.ARTISAN_ACCEPTED:
      case Status.ACCEPTED:
        return {
          artisanAcceptedAt: now,
        };

      case Status.ARTISAN_ON_THE_WAY:
      case Status.ON_THE_WAY:
        return {
          artisanOnTheWayAt: now,
        };

      case Status.ARTISAN_ARRIVED:
      case Status.ARRIVED:
        return {
          artisanArrivedAt: now,
        };

      case Status.IN_PROGRESS:
        return {
          workStartedAt: now,
        };

      case Status.WAITING_CLIENT_VALIDATION:
        return {
          waitingClientValidationAt: now,
        };

      case Status.COMPLETED:
        return {
          workCompletedAt: now,
          clientValidatedAt: now,
        };

      case Status.PAYMENT_PENDING:
        return {
          paymentPendingAt: now,
        };

      case Status.PAID:
        return {
          paidAt: now,
        };

      case Status.INVOICE_SENT:
      case Status.INVOICE_READY:
        return {
          invoiceSentAt: now,
        };

      case Status.CANCELLED:
        return {
          cancelledAt: now,
        };

      default:
        return {};
    }
  }

  private async enrichEventsWithActors(events: any[]) {
    const actorIds = [
      ...new Set(
        events
          .map((event) => event.createdById)
          .filter((id) => typeof id === 'number'),
      ),
    ];

    const actors = actorIds.length
      ? await this.prisma.user.findMany({
          where: {
            id: {
              in: actorIds,
            },
          },
          select: {
            id: true,
            name: true,
            role: true,
          },
        })
      : [];

    const actorsMap = new Map(actors.map((actor) => [actor.id, actor]));

    return events.map((event) => ({
      id: event.id,
      interventionId: event.interventionId,
      type: event.type,
      title: event.title,
      message: event.message,
      metadata: event.metadata,
      createdAt: event.createdAt,
      createdById: event.createdById,
      createdBy: event.createdById ? actorsMap.get(event.createdById) || null : null,
    }));
  }

  // ==========================================================
  // 2. TIMELINE
  // Visible to admin / client / artisan
  // ==========================================================

  async getTimeline(user: AuthenticatedUser, interventionId: number) {
    const intervention = await this.checkAccess(user, interventionId);

    const events = await this.prisma.interventionEvent.findMany({
      where: {
        interventionId,
      },
      orderBy: {
        createdAt: 'asc',
      },
    });

    // The back office reads the whole timeline, with who did what. The customer and the artisan
    // read the lines meant for them: no note of the back office, no author, no metadata.
    const enrichedEvents = this.isAdminRole(user.role)
      ? await this.enrichEventsWithActors(events)
      : eventsForParties(events);

    return {
      intervention: {
        id: intervention.id,
        status: intervention.status,
        serviceType: intervention.serviceType,
        subServiceId: intervention.subServiceId,
        address: intervention.address,
        createdAt: intervention.createdAt,
        updatedAt: intervention.updatedAt,
      },
      timeline: enrichedEvents,
    };
  }

  // ==========================================================
  // 3. PUBLIC TRACKING TIMELINE
  // Visible to public page with secure tracking token
  // ==========================================================

  async getPublicTimeline(interventionId: number, rawToken: string) {
    const intervention = await this.prisma.intervention.findUnique({
      where: {
        id: interventionId,
      },
      select: {
        id: true,
        status: true,
        serviceType: true,
        subServiceId: true,
        address: true,
        trackingToken: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // A job that does not exist and a link that is wrong get the same answer, word for word: the route must not tell
    // a visitor which job numbers are in use (P1-17).
    if (!intervention || !intervention.trackingToken || intervention.trackingToken !== this.hashToken(rawToken)) {
      throw new NotFoundException('Lien de suivi invalide ou expiré.');
    }

    const events = await this.prisma.interventionEvent.findMany({
      where: {
        interventionId,
      },
      orderBy: {
        createdAt: 'asc',
      },
    });

    return {
      intervention: {
        id: intervention.id,
        status: intervention.status,
        serviceType: intervention.serviceType,
        subServiceId: intervention.subServiceId,
        address: intervention.address,
        createdAt: intervention.createdAt,
        updatedAt: intervention.updatedAt,
      },
      timeline: eventsForParties(events),
    };
  }

  // ==========================================================
  // 4. CREATE TIMELINE EVENT
  // Reusable by admin/client/artisan/guest modules
  // ==========================================================

  async createTimelineEvent(data: {
    interventionId: number;
    type: InterventionEventType;
    title: string;
    message?: string;
    createdById?: number;
    metadata?: Prisma.InputJsonValue;
  }) {
    await this.getInterventionOrFail(data.interventionId);

    return this.prisma.interventionEvent.create({
      data: {
        interventionId: data.interventionId,
        type: data.type,
        title: data.title,
        message: data.message,
        createdById: data.createdById,
        metadata: data.metadata,
      },
    });
  }

  async createManualTimelineEvent(
    user: AuthenticatedUser,
    interventionId: number,
    dto: CreateTimelineEventDto,
  ) {
    await this.checkAdminAccess(user);
    await this.getInterventionOrFail(interventionId);

    return this.createTimelineEvent({
      interventionId,
      type: dto.type,
      title: dto.title,
      message: dto.message,
      createdById: user.id,
      metadata: dto.metadata as Prisma.InputJsonValue,
    });
  }

  // ==========================================================
  // 5. CHANGE WORKFLOW STATUS
  // Admin / dispatcher controlled generic status transition
  // ==========================================================

  async changeStatus(
    user: AuthenticatedUser,
    interventionId: number,
    dto: ChangeWorkflowStatusDto,
  ) {
    await this.checkAdminAccess(user);

    // A status cannot cancel a job (P3-01): the cancellation asks for the reason the customer and the technician read, frees the
    // technician's booked visit with its reminders, writes who cancelled, and tells the back office about money the job holds. Saying
    // "cancelled" again of a job that is cancelled already is not a cancellation, and is let through.
    if (canonicalStatus(dto.status) === 'CANCELLED') {
      const stored = await this.prisma.intervention.findUnique({ where: { id: interventionId }, select: { status: true } });

      if (stored && canonicalStatus(stored.status) !== 'CANCELLED') {
        throw new BadRequestException(CANCEL_BY_STATUS);
      }
    }

    return this.transition(
      interventionId,
      dto.status,
      { kind: 'staff', userId: user.id },
      { note: dto.note },
    );
  }

  /**
   * The workflow's front door for a status change (P1-01): checks the move
   * against the table, writes it with the matching timestamp, and adds the
   * timeline entry. Everything that moves a job goes through
   * `transitionStatus` (see transition-status.ts); this is the version for
   * callers that also want the timeline event.
   */
  async transition(
    interventionId: number,
    to: Status,
    actor: StatusActor,
    options: { note?: string; data?: Prisma.InterventionUpdateInput } = {},
  ) {
    const { row, previousStatus, changed } = await transitionStatusDetailed(
      this.prisma,
      {
        id: interventionId,
        to,
        actor,
        data: (options.data ?? {}) as Record<string, unknown>,
        dataOnChange: this.statusTimestampData(to) as Record<string, unknown>,
        include: {
          client: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
            },
          },
          artisan: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
            },
          },
          subService: true,
        },
      },
    );

    if (changed) {
      await this.createTimelineEvent({
        interventionId,
        type: this.eventTypeForStatus(to),
        title: this.eventTitleForStatus(to),
        message:
          options.note || `Statut modifié: ${previousStatus} -> ${to}`,
        createdById: actor.userId,
        metadata: {
          previousStatus,
          newStatus: to,
        },
      });
    }

    return row;
  }

  /** Statuses the caller may move this job to right now (for buttons and dropdowns). */
  async getNextStatuses(user: AuthenticatedUser, interventionId: number) {
    const intervention = await this.getInterventionOrFail(interventionId);
    const kind = actorKindFor(user, intervention);

    if (!kind) {
      throw new ForbiddenException('Accès refusé à cette intervention.');
    }

    return {
      interventionId,
      status: intervention.status,
      // The back office cancels with the cancellation, not with a status (P3-01): it is not offered here.
      allowedNextStatuses: allowedNextStatuses(intervention.status, kind, {
        hasArtisan: intervention.artisanId !== null && intervention.artisanId !== undefined,
      }).filter((status) => kind !== 'staff' || canonicalStatus(status) !== 'CANCELLED'),
    };
  }

  private async applyTransition(
    interventionId: number,
    to: Status,
    createdById?: number,
    data: Record<string, unknown> = {},
  ) {
    // Internal helpers: the calling service already knows who the user is, the
    // table still decides which move is legal. They act as the back office.
    return transitionStatusDetailed(this.prisma, {
      id: interventionId,
      to,
      actor: { kind: 'staff', userId: createdById },
      data,
    });
  }

  // ==========================================================
  // 6. PROFESSIONAL WORKFLOW HELPERS
  // These methods can be called inside your other services.
  // ==========================================================

  async markRequestCreated(interventionId: number, createdById?: number) {
    await this.prisma.intervention.update({
      where: {
        id: interventionId,
      },
      data: {
        requestCreatedAt: new Date(),
        lastStatusChangedAt: new Date(),
      },
    });

    return this.createTimelineEvent({
      interventionId,
      type: InterventionEventType.REQUEST_CREATED,
      title: 'Demande créée',
      message: 'La demande d’intervention a été créée.',
      createdById,
    });
  }

  async markWaitingAdminReview(interventionId: number, createdById?: number) {
    await this.applyTransition(interventionId, Status.WAITING_ADMIN_REVIEW, createdById, {
      adminReviewStartedAt: new Date(),
    });

    return this.createTimelineEvent({
      interventionId,
      type: InterventionEventType.ADMIN_REVIEWING,
      title: 'Analyse admin en attente',
      message: 'La demande est en attente de validation par l’administration.',
      createdById,
    });
  }

  async markQuoteSent(
    interventionId: number,
    createdById?: number,
    amountTTC?: MoneyInput,
  ) {
    await this.applyTransition(interventionId, Status.QUOTE_SENT, createdById, {
      quoteSentAt: new Date(),
    });

    return this.createTimelineEvent({
      interventionId,
      type: InterventionEventType.QUOTE_SENT,
      title: 'Devis envoyé',
      message:
        amountTTC !== undefined
          ? `Un devis de ${formatMoney(amountTTC)} TTC a été envoyé.`
          : 'Un devis a été envoyé au client.',
      createdById,
      metadata:
        amountTTC !== undefined
          ? {
              amountTTC: money(amountTTC),
            }
          : undefined,
    });
  }

  async markQuoteAccepted(interventionId: number, createdById?: number) {
    await this.applyTransition(interventionId, Status.QUOTE_ACCEPTED, createdById, {
      quoteAcceptedAt: new Date(),
    });

    return this.createTimelineEvent({
      interventionId,
      type: InterventionEventType.QUOTE_ACCEPTED,
      title: 'Devis accepté',
      message: 'Le client a accepté le devis.',
      createdById,
    });
  }

  async markArtisanAccepted(interventionId: number, createdById?: number) {
    await this.applyTransition(interventionId, Status.ARTISAN_ACCEPTED, createdById, {
      artisanAcceptedAt: new Date(),
    });

    return this.createTimelineEvent({
      interventionId,
      type: InterventionEventType.ARTISAN_ACCEPTED,
      title: 'Mission acceptée',
      message: 'L’artisan a accepté la mission.',
      createdById,
    });
  }

  async markArtisanOnTheWay(interventionId: number, createdById?: number) {
    await this.applyTransition(interventionId, Status.ARTISAN_ON_THE_WAY, createdById, {
      artisanOnTheWayAt: new Date(),
    });

    return this.createTimelineEvent({
      interventionId,
      type: InterventionEventType.ARTISAN_ON_THE_WAY,
      title: 'Artisan en route',
      message: 'L’artisan est en route vers le lieu d’intervention.',
      createdById,
    });
  }

  async markArtisanArrived(interventionId: number, createdById?: number) {
    await this.applyTransition(interventionId, Status.ARTISAN_ARRIVED, createdById, {
      artisanArrivedAt: new Date(),
    });

    return this.createTimelineEvent({
      interventionId,
      type: InterventionEventType.ARTISAN_ARRIVED,
      title: 'Artisan arrivé',
      message: 'L’artisan est arrivé sur place.',
      createdById,
    });
  }

  async markBeforePhotoUploaded(
    interventionId: number,
    createdById?: number,
    photoUrl?: string,
  ) {
    return this.createTimelineEvent({
      interventionId,
      type: InterventionEventType.BEFORE_PHOTO_UPLOADED,
      title: 'Photo avant intervention ajoutée',
      message: 'Une photo avant intervention a été ajoutée.',
      createdById,
      metadata: photoUrl
        ? {
            photoUrl,
          }
        : undefined,
    });
  }

  async markWorkStarted(interventionId: number, createdById?: number) {
    await this.applyTransition(interventionId, Status.IN_PROGRESS, createdById, {
      workStartedAt: new Date(),
    });

    return this.createTimelineEvent({
      interventionId,
      type: InterventionEventType.WORK_STARTED,
      title: 'Intervention commencée',
      message: 'L’artisan a commencé l’intervention.',
      createdById,
    });
  }

  async markAfterPhotoUploaded(
    interventionId: number,
    createdById?: number,
    photoUrl?: string,
  ) {
    return this.createTimelineEvent({
      interventionId,
      type: InterventionEventType.AFTER_PHOTO_UPLOADED,
      title: 'Photo après intervention ajoutée',
      message: 'Une photo après intervention a été ajoutée.',
      createdById,
      metadata: photoUrl
        ? {
            photoUrl,
          }
        : undefined,
    });
  }

  async markWaitingClientValidation(
    interventionId: number,
    createdById?: number,
  ) {
    await this.applyTransition(interventionId, Status.WAITING_CLIENT_VALIDATION, createdById, {
      waitingClientValidationAt: new Date(),
    });

    return this.createTimelineEvent({
      interventionId,
      type: InterventionEventType.CLIENT_VALIDATION_PENDING,
      title: 'Validation client demandée',
      message: 'L’intervention attend la validation du client.',
      createdById,
    });
  }

  async markWorkCompleted(interventionId: number, createdById?: number) {
    await this.applyTransition(interventionId, Status.COMPLETED, createdById, {
      workCompletedAt: new Date(),
      clientValidatedAt: new Date(),
    });

    return this.createTimelineEvent({
      interventionId,
      type: InterventionEventType.WORK_COMPLETED,
      title: 'Intervention terminée',
      message: 'L’intervention a été terminée.',
      createdById,
    });
  }

  async markPaymentPending(interventionId: number, createdById?: number) {
    await this.applyTransition(interventionId, Status.PAYMENT_PENDING, createdById, {
      paymentPendingAt: new Date(),
    });

    return this.createTimelineEvent({
      interventionId,
      type: InterventionEventType.PAYMENT_PENDING,
      title: 'Paiement en attente',
      message: 'Le paiement est en attente.',
      createdById,
    });
  }

  async markClientPaid(
    interventionId: number,
    createdById?: number,
    amount?: MoneyInput,
  ) {
    await this.applyTransition(interventionId, Status.PAID, createdById, {
      paidAt: new Date(),
    });

    return this.createTimelineEvent({
      interventionId,
      type: InterventionEventType.CLIENT_PAID,
      title: 'Paiement confirmé',
      message:
        amount !== undefined
          ? `Le client a payé ${formatMoney(amount)}.`
          : 'Le paiement du client a été confirmé.',
      createdById,
      metadata:
        amount !== undefined
          ? {
              amount: money(amount),
            }
          : undefined,
    });
  }

  async markInvoiceSent(interventionId: number, createdById?: number) {
    await this.applyTransition(interventionId, Status.INVOICE_SENT, createdById, {
      invoiceSentAt: new Date(),
    });

    return this.createTimelineEvent({
      interventionId,
      type: InterventionEventType.INVOICE_SENT,
      title: 'Facture envoyée',
      message: 'La facture a été envoyée au client.',
      createdById,
    });
  }

  async markReviewSubmitted(
    interventionId: number,
    createdById?: number,
    rating?: number,
  ) {
    return this.createTimelineEvent({
      interventionId,
      type: InterventionEventType.REVIEW_SUBMITTED,
      title: 'Avis client envoyé',
      message:
        rating !== undefined
          ? `Le client a laissé une note de ${rating}/5.`
          : 'Le client a laissé un avis.',
      createdById,
      metadata:
        rating !== undefined
          ? {
              rating,
            }
          : undefined,
    });
  }
}
