import { paginated } from '../../common/api-contract/envelope';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import * as argon2 from 'argon2';
import * as crypto from 'crypto';

import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { InterventionEventsService } from '../intervention-events/intervention-events.service';
import { ContactChangeService } from '../users/contact-change.service';
import { AssignmentService } from '../assignment/assignment.service';
import {
  phoneColumns,
  phoneWhere,
  rethrowContactConflict,
} from '../../common/contact/phone';
import { appFacingStatus, canonicalStatus, statusesInGroup } from '../intervention-workflow/intervention-status';
import { cancelVisit } from '../assignment/appointment-release';
import { RealtimeService } from '../realtime/realtime.service';
import {
  CaseFilePerson,
  INTERVENTION_NOTE_MAX,
  caseFileOf,
  caseNoteOf,
  peopleToLookUp,
} from '../../common/views/case-file';
import { describeError } from '../notifications/delivery/delivery-error';
import { complaintCase, complaintList } from './complaint-center';
import { closeComplaintIfRefundAnswered, endsComplaint } from '../complaints/complaint-closing';
import {
  interventionListSelect,
  interventionQueueOrder,
  interventionQueueWhere,
} from './intervention-queue';
import { tradeFieldsFor, tradeFieldsForEdit } from '../artisans/trade-fields';
import { InviteReason, inviteArtisan } from '../auth/invite';
import { artisanZoneRowsFor } from '../service-zones/zone-pick';
import { isStoredFileUrl } from '../files/stored-file-url';
import { totalsFromItems } from '../../common/money/document-totals';
import { compareMoney, formatMoney, money, subtractMoney, sumMoney, sumMoneyOf } from '../../common/money/money';
import { paymentFigures, REFUND_ALREADY_MADE, REFUND_MADE_DECISIONS, settleComplaintRefund } from '../payments/financials-ops';
import { lockJob } from '../assignment/artisan-lock';
import { positionAge } from '../../common/geo/location-rules';
import { routeOfJob } from '../locations/route-of-job';
import { INVOICES_OF_JOB } from '../invoices/invoice-includes';
import { STAMP_DUTY_MAX, printedSettingsChanged } from '../invoices/invoice-legal';
import { startOfBusinessDay, startOfBusinessMonth } from '../../common/locale/business-time';
import { DEFAULT_LOCALE, DEFAULT_TAX_RATES, TaxRateOption, applyLocale, currencyCode, getLocale, parseTaxRates, resolveLocale } from '../../common/locale/locale';
import { effectiveTaxRates, localeOfRow } from '../../common/locale/locale.service';
import { normalizeMatriculeFiscal, normalizeRib } from '../../common/locale/company-identity';
import { getBusinessTimeZone } from '../../config/env';
import {
  transitionStatus,
  transitionStatusDetailed,
} from '../intervention-workflow/transition-status';

import {
  AdminContactDto,
  AdminInternalNoteDto,
  AdminInterventionQueryDto,
  AdminArtisanQueryDto,
  AdminClientQueryDto,
  AdminComplaintQueryDto,
  AdminApproveArtisanDto,
  AdminRejectArtisanDto,
  AdminReviewArtisanDto,
  AdminSendQuoteDto,
  AssignArtisanDto,
  AssignComplaintDto,
  CancelInterventionDto,
  ChangeInterventionStatusDto,
  CreateAdminServiceZoneDto,
  CreateArtisanManualDto,
  CreateNotificationTemplateDto,
  DecideRefundDto,
  EditArtisanProfileDto,
  EditClientDto,
  InterventionNoteDto,
  UpdateAdminServiceZoneDto,
  UpdateCompanySettingsDto,
  UpdateComplaintStatusDto,
  UpdateNotificationTemplateDto,
  UpdateServiceCategoryPricingDto,
  UpdateSubServicePricingDto,
  VerifyArtisanDocumentDto,
} from './dto/admin.dto';

import {
  AdminNoteTargetType,
  ArtisanAvailabilityStatus,
  ArtisanDocumentStatus,
  ArtisanDocumentType,
  ArtisanVerificationStatus,
  ComplaintRefundDecision,
  ComplaintStatus,
  InterventionEventType,
  MessageAudience,
  NotificationChannel,
  NotificationType,
  PaymentStatus,
  Prisma,
  QuoteStatus,
  Role,
  Status,
} from '../../../generated/prisma/client';
import { Permission, can } from '../../common/auth/permissions';
import { MESSAGES, localeOfUser, moneyIn, notice, recipientLocale, reference, say } from '../../common/i18n/messages';

/** The last page the list can be asked for: with 100 rows a page, the offset stays far below what the database holds. */
const MAX_PAGE = 1_000_000;

/** The largest job number the database stores (a 32-bit integer): a bigger one is no job's, and asking for it would be a database error. */
const MAX_ROW_ID = 2_147_483_647;

/** The answer when someone else decided the same profile first. */
const ALREADY_DECIDED = 'Ce profil vient d’être traité par un autre membre de l’équipe: rechargez la liste.';

/** The payments that still hold money received: paid, and paid then partly given back (what is left of them counts). */
const PAID_PAYMENT_STATUSES: PaymentStatus[] = [PaymentStatus.PAID, PaymentStatus.PARTIALLY_REFUNDED];

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly events: InterventionEventsService,
    private readonly contactChange: ContactChangeService,
    private readonly assignment: AssignmentService,
    private readonly realtime: RealtimeService,
  ) {}

  private readonly logger = new Logger(AdminService.name);

  // ==========================================================
  // 1. HELPERS
  // ==========================================================

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private generateUnusablePassword(): string {
    return `AdminCreated-Unusable-${crypto.randomBytes(64).toString('hex')}`;
  }

  private isAssignableSupportRole(role: Role): boolean {
    return can(role, Permission.COMPLAINTS_ASSIGNEE);
  }

  private getPagination(page?: string | number, limit?: string | number) {
    // Text that is not a number ("abc", "1.5") is the default, not a NaN that Prisma refuses with a 500.
    const wholeNumber = (value: string | number | undefined, fallback: number) => {
      const number = Number(value || fallback);

      return Number.isSafeInteger(number) ? number : fallback;
    };

    // A page past a million is no page of this list; "1e21" is a whole number to JavaScript but not to the database.
    const safePage = Math.min(MAX_PAGE, Math.max(1, wholeNumber(page, 1)));
    const safeLimit = Math.min(100, Math.max(1, wholeNumber(limit, 20)));

    return {
      page: safePage,
      limit: safeLimit,
      skip: (safePage - 1) * safeLimit,
      take: safeLimit,
    };
  }

  private safeUserSelect = {
    id: true,
    email: true,
    name: true,
    phone: true,
    address: true,
    role: true,
    isActive: true,
    isGuest: true,
    latitude: true,
    longitude: true,
    positionAt: true,
    createdAt: true,
    updatedAt: true,
  };

  private interventionInclude = {
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
        latitude: true,
        longitude: true,
      },
    },
    subService: true,
    events: {
      orderBy: {
        createdAt: 'asc' as const,
      },
    },
    quotes: {
      include: {
        items: true,
      },
      orderBy: {
        createdAt: 'desc' as const,
      },
    },
    payments: {
      orderBy: {
        createdAt: 'desc' as const,
      },
    },
    invoices: INVOICES_OF_JOB,
    complaints: true,
    messages: {
      include: {
        sender: {
          select: {
            id: true,
            name: true,
            role: true,
          },
        },
      },
      orderBy: {
        createdAt: 'asc' as const,
      },
    },
    review: true,
  };

  /**
   * The one-time link that lets an artisan the back office accepted or added choose a password:
   * one function for both (see auth/invite.ts). The link is in the answer only while the mails
   * are simulated.
   */
  private async invite(userId: number, reason: InviteReason) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('Utilisateur introuvable.');
    }

    return inviteArtisan({ prisma: this.prisma, notifications: this.notifications }, user, reason);
  }

  private async addInternalNote(data: {
    authorId?: number;
    targetType: AdminNoteTargetType;
    targetId: number;
    content: string;
  }) {
    return this.prisma.adminInternalNote.create({
      data,
    });
  }

  private async createInterventionEvent(data: {
    interventionId: number;
    type: InterventionEventType;
    title: string;
    message?: string;
    createdById?: number;
  }) {
    return this.events.create(data);
  }

  private averageDurationInMinutes(
    items: Array<{ start: Date; end: Date | null }>,
  ) {
    const validItems = items.filter((item) => item.end);

    if (!validItems.length) {
      return 0;
    }

    const totalMs = validItems.reduce((sum, item) => {
      return sum + (item.end!.getTime() - item.start.getTime());
    }, 0);

    return Math.round(totalMs / validItems.length / 1000 / 60);
  }

  // ==========================================================
  // 2. MAIN DASHBOARD KPIs
  // ==========================================================

  async getDashboardKpis(query?: { from?: string; to?: string }) {
    const now = new Date();

    // Today and this month begin at midnight on the clock of the business, not on the one of the server.
    const startOfToday = startOfBusinessDay(now);

    const startOfMonth = startOfBusinessMonth(now);

    const createdAtFilter: Prisma.DateTimeFilter = {};

    if (query?.from) {
      createdAtFilter.gte = new Date(query.from);
    }

    if (query?.to) {
      createdAtFilter.lte = new Date(query.to);
    }

    const baseWhere: Prisma.InterventionWhereInput =
      query?.from || query?.to
        ? {
            createdAt: createdAtFilter,
          }
        : {};

    const [
      totalInterventions,
      pendingInterventions,
      activeInterventions,
      completedInterventions,
      cancelledInterventions,
      disputedInterventions,
      responseTimeRows,
      completionTimeRows,
      monthlyRevenue,
      todayRevenue,
      activeArtisans,
      averageRating,
      complaintsCount,
    ] = await Promise.all([
      this.prisma.intervention.count({
        where: baseWhere,
      }),

      this.prisma.intervention.count({
        where: {
          ...baseWhere,
          status: {
            in: statusesInGroup('waiting') as Status[],
          },
        },
      }),

      this.prisma.intervention.count({
        where: {
          ...baseWhere,
          status: {
            in: statusesInGroup('active') as Status[],
          },
        },
      }),

      this.prisma.intervention.count({
        where: {
          ...baseWhere,
          status: {
            in: statusesInGroup('completed') as Status[],
          },
        },
      }),

      this.prisma.intervention.count({
        where: {
          ...baseWhere,
          status: Status.CANCELLED,
        },
      }),

      this.prisma.intervention.count({
        where: {
          ...baseWhere,
          status: Status.DISPUTED,
        },
      }),

      this.prisma.intervention.findMany({
        where: {
          ...baseWhere,
          artisanAcceptedAt: {
            not: null,
          },
        },
        select: {
          createdAt: true,
          artisanAcceptedAt: true,
        },
      }),

      this.prisma.intervention.findMany({
        where: {
          ...baseWhere,
          workCompletedAt: {
            not: null,
          },
        },
        select: {
          createdAt: true,
          workCompletedAt: true,
        },
      }),

      this.prisma.payment.aggregate({
        where: {
          status: { in: PAID_PAYMENT_STATUSES },
          createdAt: {
            gte: startOfMonth,
          },
        },
        _sum: {
          amount: true,
          amountRefunded: true,
        },
      }),

      this.prisma.payment.aggregate({
        where: {
          status: { in: PAID_PAYMENT_STATUSES },
          createdAt: {
            gte: startOfToday,
          },
        },
        _sum: {
          amount: true,
          amountRefunded: true,
        },
      }),

      this.prisma.artisanProfile.count({
        where: {
          verificationStatus: ArtisanVerificationStatus.APPROVED,
          availabilityStatus: ArtisanAvailabilityStatus.ONLINE,
          isAcceptingJobs: true,
        },
      }),

      this.prisma.review.aggregate({
        _avg: {
          rating: true,
        },
      }),

      this.prisma.complaint.count({
        where: {
          status: {
            in: [
              ComplaintStatus.OPEN,
              ComplaintStatus.IN_REVIEW,
              ComplaintStatus.WAITING_ARTISAN,
              ComplaintStatus.WAITING_CLIENT,
            ],
          },
        },
      }),
    ]);

    return {
      totalInterventions,
      pendingInterventions,
      activeInterventions,
      completedInterventions,
      cancelledInterventions,
      disputedInterventions,
      averageResponseTimeMinutes: this.averageDurationInMinutes(
        responseTimeRows.map((row) => ({
          start: row.createdAt,
          end: row.artisanAcceptedAt,
        })),
      ),
      averageCompletionTimeMinutes: this.averageDurationInMinutes(
        completionTimeRows.map((row) => ({
          start: row.createdAt,
          end: row.workCompletedAt,
        })),
      ),
      monthlyRevenue: subtractMoney(money(monthlyRevenue._sum.amount), money(monthlyRevenue._sum.amountRefunded)),
      todayRevenue: subtractMoney(money(todayRevenue._sum.amount), money(todayRevenue._sum.amountRefunded)),
      activeArtisans,
      averageRating: averageRating._avg.rating || 0,
      complaintsCount,
    };
  }

  // ==========================================================
  // 3. INTERVENTION MANAGEMENT
  // ==========================================================

  /**
   * The dispatcher's list (P1-13): a page of jobs, filtered by tab, status, urgency, trade, place,
   * date or a search text, in the order of work (`sort=queue`: most urgent first, then longest
   * waiting) or by date. The rules are in intervention-queue.ts; the rows are the lean list rows,
   * the whole job is `GET /admin/interventions/:id`.
   */
  async findAllInterventions(query: AdminInterventionQueryDto) {
    const { page, limit, skip, take } = this.getPagination(
      query.page,
      query.limit,
    );

    const where = interventionQueueWhere(query) as Prisma.InterventionWhereInput;
    const orderBy = interventionQueueOrder(query.sort) as Prisma.InterventionOrderByWithRelationInput[];

    const [data, total] = await Promise.all([
      this.prisma.intervention.findMany({
        where,
        select: interventionListSelect,
        orderBy,
        skip,
        take,
      }),

      this.prisma.intervention.count({
        where,
      }),
    ]);

    return paginated(data, page, limit, total);
  }

  /**
   * The case file of a job (P1-14): what the back office needs to follow it from the request to
   * its end without leaving the page. It is built from an explicit list (see views/case-file.ts),
   * not from the rows: the customer's tracking link, the artisan's position and the other readers
   * of a message do not leave. A number that is no job's (zero, negative, beyond what the database
   * stores) is a 404, not a database error.
   */
  async getInterventionDetail(id: number) {
    this.refuseUnknownJob(id);

    const job = await this.prisma.intervention.findUnique({
      where: { id },
      include: {
        client: { select: { id: true, name: true, phone: true, email: true } },
        artisan: { select: { id: true, name: true, phone: true, email: true } },
        subService: { select: { id: true, name: true } },
      },
    });

    if (!job) {
      throw new NotFoundException('Intervention introuvable.');
    }

    const [events, messages, notes] = await Promise.all([
      this.prisma.interventionEvent.findMany({
        where: { interventionId: id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.message.findMany({
        where: { interventionId: id },
        include: { sender: { select: { id: true, name: true, role: true } } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.adminInternalNote.findMany({
        where: {
          targetType: AdminNoteTargetType.INTERVENTION,
          targetId: id,
          deletedAt: null,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    ]);

    const people = await this.peopleByIds(peopleToLookUp(job, events, notes));

    return caseFileOf({ job, events, messages, notes, people });
  }

  /** A job number the database could hold; anything else cannot be a job. */
  private refuseUnknownJob(id: number) {
    if (!Number.isInteger(id) || id < 1 || id > MAX_ROW_ID) {
      throw new NotFoundException('Intervention introuvable.');
    }
  }

  /** The name and role of these accounts, by id. */
  private async peopleByIds(ids: number[]): Promise<Map<number, CaseFilePerson>> {
    const people = new Map<number, CaseFilePerson>();

    if (ids.length === 0) return people;

    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, role: true },
    });

    for (const user of users) people.set(user.id, { id: user.id, name: user.name ?? null, role: user.role ?? null });

    return people;
  }

  /**
   * Gives a job to an artisan: the one path in AssignmentService (approval, status,
   * availability, appointment, reminders, timeline, notifications) (P1-05).
   */
  async assignArtisan(
    adminId: number,
    interventionId: number,
    dto: AssignArtisanDto,
  ) {
    const { intervention } = await this.assignment.assign({
      interventionId,
      artisanId: dto.artisanId,
      actorId: adminId,
      startsAt: dto.startsAt,
      endsAt: dto.endsAt,
      adminNote: dto.adminNote,
      include: this.interventionInclude,
    });

    return intervention;
  }

  async changeInterventionStatus(
    adminId: number,
    interventionId: number,
    dto: ChangeInterventionStatusDto,
  ) {
    const intervention = await this.prisma.intervention.findUnique({
      where: { id: interventionId },
    });

    if (!intervention) {
      throw new NotFoundException('Intervention introuvable.');
    }

    // A status cannot give a job to somebody: the assignment checks the approval, the availability and
    // the trade, and writes the technician together with the status.
    if (canonicalStatus(dto.status) === 'ASSIGNED') {
      throw new BadRequestException(
        'Pour confier la demande à un technicien, utilisez l’assignation: elle vérifie l’agrément et la disponibilité.',
      );
    }

    // Nor can a status cancel it: the cancellation asks for the reason the customer and the technician
    // read, and frees the technician's booked visit with its reminders.
    if (canonicalStatus(dto.status) === 'CANCELLED') {
      throw new BadRequestException(
        'Pour annuler la demande, utilisez l’annulation: elle demande un motif et libère le rendez-vous du technicien.',
      );
    }

    const { row: updated, changed } = await transitionStatusDetailed(
      this.prisma,
      {
        id: interventionId,
        // The old name where the apps still read it (ACCEPTED, ON_THE_WAY...), like the jobs they write.
        to: appFacingStatus(dto.status),
        actor: { kind: 'staff', userId: adminId },
        // The screen names the status it showed: if somebody moved the job since, nothing is written.
        ...(dto.expectedStatus ? { allowedFrom: [dto.expectedStatus] } : {}),
        conflictMessage: 'Le statut de la demande a changé entre-temps. Rechargez la liste avant de recommencer.',
        include: this.interventionInclude,
      },
    );

    if (changed) {
      // The line in the timeline is read by the customer and the artisan: it says what changed.
      // The note the back office typed with it is for the back office, in a line of its own that
      // the people of the job do not get (P1-08).
      await this.createInterventionEvent({
        interventionId,
        type: InterventionEventType.ADMIN_REVIEWING,
        title: 'Statut modifié par admin',
        message: `Nouveau statut: ${dto.status}`,
        createdById: adminId,
      });

      if (dto.note) {
        await this.createInterventionEvent({
          interventionId,
          type: InterventionEventType.INTERNAL_NOTE_ADDED,
          title: 'Note du changement de statut',
          message: dto.note,
          createdById: adminId,
        });
      }

      await this.tellAboutStatusChange(String(intervention.status), updated, adminId);
    }

    return updated;
  }

  /**
   * What the others hear once the back office has moved a job (P1-13): the live event (the other
   * dispatchers' lists, the customer's and the technician's screens), the texts the customer got from
   * the deleted route (P3-03: the technician accepted; the job is done) and, for a cancellation, the notice to
   * the technician. The status is written already: each message is attempted alone, and one that
   * fails is logged (its kind only, a phone number or an address could be in the details) and does not
   * undo or hide the change.
   */
  private async tellAboutStatusChange(before: string, row: any, adminId: number, cancelled?: { reason: string }) {
    const attempt = async (what: string, work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        this.logger.error(`After a status change by the back office, the ${what} failed (${describeError(error)}).`);
      }
    };

    await attempt('live event', () =>
      this.realtime.emitStatusChange({
        interventionId: row.id,
        oldStatus: before,
        newStatus: row.status,
        actorId: adminId,
      }),
    );

    const now = canonicalStatus(row.status);
    const phone: string | null | undefined = row.client?.phone;

    if ((now === 'ARTISAN_ACCEPTED' || now === 'COMPLETED') && phone) {
      // The customer is written to in their own language (French when it cannot be read).
      const locale = await localeOfUser(this.prisma, row.clientId ?? row.client?.id);

      if (now === 'ARTISAN_ACCEPTED') {
        const name = row.artisan?.name;

        await attempt('text to the customer', () =>
          this.notifications.sendSms(
            phone,
            name
              ? say(MESSAGES.mission.accepted.smsNamed, locale, { name })
              : say(MESSAGES.mission.accepted.sms, locale),
          ),
        );
      }

      if (now === 'COMPLETED') {
        await attempt('text to the customer', () => this.notifications.sendSms(phone, say(MESSAGES.mission.completed.smsAfterStatusChange, locale)));
      }
    }

    if (cancelled && typeof row.artisanId === 'number') {
      await attempt('notice to the technician', () =>
        this.notifications.notify({
          recipientId: row.artisanId,
          actorId: adminId,
          type: NotificationType.GENERAL,
          ...notice((locale) => ({
            title: say(MESSAGES.mission.cancelled.title, locale),
            message: say(MESSAGES.mission.cancelled.message, locale, { ref: reference(row.id), reason: cancelled.reason }),
          })),
          channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
          entityType: 'INTERVENTION',
          entityId: row.id,
        }),
      );
    }
  }

  async cancelIntervention(
    adminId: number,
    interventionId: number,
    dto: CancelInterventionDto,
  ) {
    const intervention = await this.prisma.intervention.findUnique({
      where: { id: interventionId },
    });

    if (!intervention) {
      throw new NotFoundException('Intervention introuvable.');
    }

    // The customer and the technician read the reason: a blank one says nothing.
    const reason = String(dto.reason ?? '').trim();

    if (!reason) {
      throw new BadRequestException('Indiquez le motif de l’annulation.');
    }

    // The status and the visit are written together: a cancelled job must not keep the technician's
    // calendar blocked or its reminders going out.
    const { row: updated, changed, previousStatus } = await this.prisma.$transaction(async (tx) => {
      // The lock of the job first, as every other writer of its visit takes it (P3-01).
      await lockJob(tx, interventionId);

      const result = await transitionStatusDetailed(tx, {
        id: interventionId,
        to: Status.CANCELLED,
        actor: { kind: 'staff', userId: adminId },
        ...(dto.expectedStatus ? { allowedFrom: [dto.expectedStatus] } : {}),
        conflictMessage: 'Le statut de la demande a changé entre-temps. Rechargez la liste avant de recommencer.',
        dataOnChange: {
          cancelledReason: reason,
          cancelledById: adminId,
          cancelledAt: new Date(),
        },
        include: this.interventionInclude,
      });

      // Also when the job was cancelled already: a job cancelled before this rule (or by a route that did not free the visit) may still hold an
      // hour, and cancelling it again is how the back office frees it. A visit that is over or already cancelled is left alone.
      await cancelVisit(tx as any, interventionId, reason, adminId);

      return result;
    });

    if (changed) {
      await this.createInterventionEvent({
        interventionId,
        type: InterventionEventType.CANCELLED,
        title: 'Intervention annulée',
        message: reason,
        createdById: adminId,
      });

      await this.tellAboutStatusChange(String(previousStatus ?? intervention.status), updated, adminId, { reason });
    }

    return updated;
  }

  /**
   * A note on a job that only the back office reads (P1-14). Blank is refused (a note nobody can read
   * says nothing) and so is a text longer than the form allows; the text is kept as it was written,
   * without the spaces around it. The answer is the note as the case file lists it, with its author.
   */
  async addInterventionInternalNote(
    adminId: number,
    interventionId: number,
    dto: InterventionNoteDto,
  ) {
    this.refuseUnknownJob(interventionId);

    const content = typeof dto?.content === 'string' ? dto.content.trim() : '';

    if (content.length === 0) {
      throw new BadRequestException('La note est vide.');
    }

    if (content.length > INTERVENTION_NOTE_MAX) {
      throw new BadRequestException(`La note est trop longue (${INTERVENTION_NOTE_MAX} caractères au plus).`);
    }

    const job = await this.prisma.intervention.findUnique({ where: { id: interventionId }, select: { id: true } });

    if (!job) {
      throw new NotFoundException('Intervention introuvable.');
    }

    const note = await this.addInternalNote({
      authorId: adminId,
      targetType: AdminNoteTargetType.INTERVENTION,
      targetId: interventionId,
      content,
    });

    return caseNoteOf(note, await this.peopleByIds([adminId]));
  }

  async sendQuote(
    adminId: number,
    interventionId: number,
    dto: AdminSendQuoteDto,
  ) {
    const intervention = await this.prisma.intervention.findUnique({
      where: { id: interventionId },
      include: {
        client: true,
      },
    });

    if (!intervention) {
      throw new NotFoundException('Intervention introuvable.');
    }

    const totals = totalsFromItems('quote', dto.items, dto.taxRate);
    const { amountTTC } = totals;

    const quote = await this.prisma.quote.create({
      data: {
        interventionId,
        createdById: adminId,
        title: dto.title,
        description: dto.description,
        currency: currencyCode(),
        amountHT: totals.amountHT,
        taxRate: totals.taxRate,
        taxAmount: totals.taxAmount,
        amountTTC,
        status: QuoteStatus.SENT,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
        items: {
          create: totals.items,
        },
      },
      include: {
        items: true,
      },
    });

    await transitionStatus(this.prisma, {
      id: interventionId,
      to: Status.QUOTE_SENT,
      actor: { kind: 'staff', userId: adminId },
      data: { quoteSentAt: new Date() },
      soft: true,
    });

    await this.createInterventionEvent({
      interventionId,
      type: InterventionEventType.QUOTE_SENT,
      title: 'Devis envoyé',
      message: `Devis envoyé par l’administration: ${formatMoney(amountTTC)} TTC.`,
      createdById: adminId,
    });

    // The customer is written to in their own language.
    const locale = recipientLocale(intervention.client);

    if (intervention.contactPhone || intervention.client.phone) {
      await this.notifications.sendSms(
        intervention.contactPhone || intervention.client.phone!,
        say(MESSAGES.quote.sent.sms, locale, { amount: moneyIn(locale, amountTTC) }),
      );
    }

    if (intervention.contactEmail || intervention.client.email) {
      await this.notifications.sendEmail(
        intervention.contactEmail || intervention.client.email,
        say(MESSAGES.quote.sent.emailSubject, locale),
        say(MESSAGES.quote.sent.emailBody, locale, { amount: moneyIn(locale, amountTTC) }),
      );
    }

    // In the app only: the SMS and the e-mail above already went out (never throws).
    await this.notifications.notifyQuoteSent(quote.id, adminId, [
      NotificationChannel.IN_APP,
      NotificationChannel.PUSH,
    ]);

    return quote;
  }

  // ==========================================================
  // 4. ARTISAN MANAGEMENT
  // ==========================================================

  async findAllArtisans(query: AdminArtisanQueryDto) {
    const { page, limit, skip, take } = this.getPagination(
      query.page,
      query.limit,
    );

    const where: Prisma.ArtisanProfileWhereInput = {};

    if (query.status) {
      where.verificationStatus = query.status;
    }

    if (query.search) {
      where.OR = [
        {
          user: {
            name: {
              contains: query.search,
              mode: 'insensitive',
            },
          },
        },
        {
          user: {
            email: {
              contains: query.search,
              mode: 'insensitive',
            },
          },
        },
        {
          user: {
            phone: {
              contains: query.search,
              mode: 'insensitive',
            },
          },
        },
        {
          companyName: {
            contains: query.search,
            mode: 'insensitive',
          },
        },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.artisanProfile.findMany({
        where,
        include: {
          user: {
            select: this.safeUserSelect,
          },
          documents: true,
          serviceZones: true,
          availability: true,
          bankDetails: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
        skip,
        take,
      }),

      this.prisma.artisanProfile.count({
        where,
      }),
    ]);

    return paginated(data, page, limit, total);
  }

  async getArtisanDetail(profileId: number) {
    const profile = await this.prisma.artisanProfile.findUnique({
      where: { id: profileId },
      include: {
        user: {
          select: this.safeUserSelect,
        },
        documents: true,
        serviceZones: true,
        availability: true,
        bankDetails: true,
        missionRejections: true,
      },
    });

    if (!profile) {
      throw new NotFoundException('Profil artisan introuvable.');
    }

    const internalNotes = await this.prisma.adminInternalNote.findMany({
      where: {
        targetType: AdminNoteTargetType.ARTISAN,
        targetId: profileId,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return {
      ...profile,
      internalNotes,
    };
  }

  /**
   * "Add technician": an artisan the back office vouches for. The account exists at once and is
   * approved, ready for a job (zones and trades included), and the artisan gets the one-time link
   * to choose a password. The answer carries that link while the mails are simulated.
   */
  async createArtisanManually(
    adminId: number,
    dto: CreateArtisanManualDto,
  ) {
    // The trades first: a name that is no trade is refused before anything is created (P1-10).
    const trades = tradeFieldsFor({ specialty: dto.specialty, specialties: dto.specialties })!;

    // The zones are picked from the platform's list, like an applicant's (P1-11); none is allowed:
    // the artisan is then not limited to a place.
    const zones = await artisanZoneRowsFor(this.prisma, dto.zoneIds ?? []);

    const email = this.normalizeEmail(dto.email);

    const existingUser = await this.prisma.user.findFirst({
      where: {
        OR: [{ email }, phoneWhere(dto.phone)].filter(Boolean) as any[],
      },
    });

    if (existingUser) {
      throw new BadRequestException(
        'Un utilisateur existe déjà avec cet email ou téléphone.',
      );
    }

    const hashedPassword = await argon2.hash(this.generateUnusablePassword());

    const profile = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user
        .create({
          data: {
            email,
            ...phoneColumns(dto.phone),
            name: dto.name,
            password: hashedPassword,
            role: Role.ARTISAN,
            isActive: true,
          },
        })
        .catch(rethrowContactConflict);

      const created = await tx.artisanProfile.create({
        data: {
          userId: user.id,
          specialty: trades.specialty,
          specialties: trades.specialties,
          serviceTypes: trades.serviceTypes,
          yearsExperience: dto.yearsExperience,
          companyName: dto.companyName,
          companyNumber: dto.companyNumber,
          insuranceNumber: dto.insuranceNumber,
          bio: dto.bio,
          profilePhotoUrl: dto.profilePhotoUrl,
          verificationStatus: ArtisanVerificationStatus.APPROVED,
          verifiedAt: new Date(),
          verifiedById: adminId,
          // approved means ready for a job (P1-05); the schema default would say "no" and the mobile app has no switch
          isAcceptingJobs: true,
          // urgent jobs too, as before: nothing could ever set this flag (turn it off from the profile)
          emergencyAvailable: true,
        },
        include: {
          user: {
            select: this.safeUserSelect,
          },
        },
      });

      if (zones.length) {
        await tx.artisanServiceZone.createMany({
          data: zones.map((zone) => ({ ...zone, artisanProfileId: created.id })),
        });
      }

      return created;
    });

    const invitation = await this.invite(profile.userId, 'created');

    return {
      message: 'Artisan créé: un lien pour choisir son mot de passe lui a été envoyé.',
      profile,
      ...invitation,
    };
  }

  async editArtisanProfile(profileId: number, dto: EditArtisanProfileDto) {
    const stored = await this.getArtisanDetail(profileId);

    // Trades are written together (the main one, the list, the service types); null = not sent (P1-10).
    const trades = tradeFieldsForEdit({ specialty: dto.specialty, specialties: dto.specialties }, stored);

    return this.prisma.artisanProfile.update({
      where: { id: profileId },
      data: trades ? { ...dto, ...trades } : dto,
      include: {
        user: {
          select: this.safeUserSelect,
        },
        documents: true,
        serviceZones: true,
        availability: true,
        bankDetails: true,
      },
    });
  }

  /**
   * Accepts an application. Only an application that waits (or one that was refused and is looked
   * at again) can be accepted; a suspended artisan is reactivated, not approved. The identity
   * document must be there and not refused: without one, the approval needs the explicit waiver
   * and a written reason, which is kept in the internal notes of the profile (the applications
   * brought over from the older form have no documents at all).
   */
  async approveArtisan(
    adminId: number,
    profileId: number,
    dto: AdminApproveArtisanDto,
  ) {
    const profile = await this.getArtisanDetail(profileId);

    if (profile.verificationStatus === ArtisanVerificationStatus.APPROVED) {
      throw new BadRequestException('Cet artisan est déjà approuvé.');
    }

    if (profile.verificationStatus === ArtisanVerificationStatus.SUSPENDED) {
      throw new BadRequestException('Ce profil est suspendu: réactivez-le au lieu de l’approuver.');
    }

    const note = typeof dto.note === 'string' ? dto.note.trim() : '';
    // A document counts when it is a file of the platform that the viewer can open: an address
    // typed by the applicant (older form) proves nothing.
    const hasIdentity = (profile.documents ?? []).some(
      (document) =>
        document.type === ArtisanDocumentType.IDENTITY &&
        document.status !== ArtisanDocumentStatus.REJECTED &&
        isStoredFileUrl(document.fileUrl),
    );

    if (!hasIdentity) {
      if (!dto.waiveIdentityCheck) {
        throw new BadRequestException(
          'Aucune pièce d’identité valable: refusez la candidature, ou approuvez sans pièce d’identité en indiquant le motif.',
        );
      }

      if (!note) {
        throw new BadRequestException('Indiquez le motif pour approuver sans pièce d’identité.');
      }
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      // The decision is taken on the state that was read above. Two staff members deciding the
      // same application at once (one accepts, one refuses) cannot both win: the profile changes
      // only if it is still in that state, and the loser changes nothing and sends nothing.
      const claimed = await tx.artisanProfile.updateMany({
        where: { id: profileId, verificationStatus: profile.verificationStatus },
        data: {
          verificationStatus: ArtisanVerificationStatus.APPROVED,
          rejectionReason: null,
          verifiedAt: new Date(),
          verifiedById: adminId,
          // approved means ready for a job (P1-05); the schema default would say "no" and the mobile app has no switch
          isAcceptingJobs: true,
          // urgent jobs too, as before: nothing could ever set this flag (turn it off from the profile)
          emergencyAvailable: true,
        },
      });

      if (claimed.count !== 1) throw new ConflictException(ALREADY_DECIDED);

      await tx.user.update({
        where: { id: profile.userId },
        data: {
          role: Role.ARTISAN,
          isActive: true,
        },
      });

      await tx.artisanDocument.updateMany({
        where: {
          artisanProfileId: profileId,
          status: ArtisanDocumentStatus.PENDING,
        },
        data: {
          status: ArtisanDocumentStatus.APPROVED,
          reviewedAt: new Date(),
          reviewedById: adminId,
        },
      });

      return tx.artisanProfile.findUnique({
        where: { id: profileId },
        include: {
          user: {
            select: this.safeUserSelect,
          },
          documents: true,
        },
      });
    });

    const invitation = await this.invite(profile.userId, 'approved');

    if (note || !hasIdentity) {
      await this.addInternalNote({
        authorId: adminId,
        targetType: AdminNoteTargetType.ARTISAN,
        targetId: profileId,
        content: hasIdentity ? note : `Approuvé sans pièce d’identité: ${note}`,
      });
    }

    return { ...updated, ...invitation };
  }

  /**
   * Refuses an application, with the reason in writing: the applicant is told it (they can fix
   * what was wrong and talk to the team), and it stays on the profile. Only an application that
   * waits can be refused; an artisan who is approved is suspended instead.
   */
  async rejectArtisan(
    adminId: number,
    profileId: number,
    dto: AdminRejectArtisanDto,
  ) {
    const profile = await this.getArtisanDetail(profileId);

    if (profile.verificationStatus !== ArtisanVerificationStatus.PENDING_REVIEW) {
      throw new BadRequestException(
        'Seule une candidature en attente peut être refusée (un artisan approuvé se suspend).',
      );
    }

    const reason = typeof dto.reason === 'string' ? dto.reason.trim() : '';

    if (reason.length < 5) {
      throw new BadRequestException('Indiquez le motif du refus (5 caractères au moins).');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      // Same rule as the acceptance: only an application that still waits can be refused.
      const claimed = await tx.artisanProfile.updateMany({
        where: { id: profileId, verificationStatus: ArtisanVerificationStatus.PENDING_REVIEW },
        data: {
          verificationStatus: ArtisanVerificationStatus.REJECTED,
          rejectionReason: reason,
        },
      });

      if (claimed.count !== 1) throw new ConflictException(ALREADY_DECIDED);

      await tx.user.update({
        where: { id: profile.userId },
        data: {
          isActive: false,
        },
      });

      return tx.artisanProfile.findUnique({
        where: { id: profileId },
        include: {
          user: {
            select: this.safeUserSelect,
          },
        },
      });
    });

    // The applicant is written to in the language they applied in.
    const locale = await localeOfUser(this.prisma, profile.userId);

    await this.notifications.sendEmail(
      profile.user.email,
      say(MESSAGES.application.rejected.title, locale),
      say(MESSAGES.application.rejected.emailBody, locale, { reason }),
    );

    return updated;
  }

  async verifyArtisanDocument(
    adminId: number,
    documentId: number,
    dto: VerifyArtisanDocumentDto,
  ) {
    const document = await this.prisma.artisanDocument.findUnique({
      where: { id: documentId },
    });

    if (!document) {
      throw new NotFoundException('Document introuvable.');
    }

    return this.prisma.artisanDocument.update({
      where: { id: documentId },
      data: {
        status: dto.status,
        rejectionNote: dto.rejectionNote,
        reviewedAt: new Date(),
        reviewedById: adminId,
      },
    });
  }

  async suspendArtisan(
    adminId: number,
    profileId: number,
    dto: AdminReviewArtisanDto,
  ) {
    const profile = await this.getArtisanDetail(profileId);

    // Only an approved artisan is suspended. A pending or refused application is decided with
    // approve and reject; reactivating a suspended profile would otherwise be a way to approve
    // one without the identity check.
    if (profile.verificationStatus !== ArtisanVerificationStatus.APPROVED) {
      throw new BadRequestException('Seul un artisan approuvé peut être suspendu.');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.artisanProfile.updateMany({
        where: { id: profileId, verificationStatus: ArtisanVerificationStatus.APPROVED },
        data: {
          verificationStatus: ArtisanVerificationStatus.SUSPENDED,
          rejectionReason: dto.note || 'Profil suspendu.',
          availabilityStatus: ArtisanAvailabilityStatus.UNAVAILABLE,
          isAcceptingJobs: false,
        },
      });

      if (claimed.count !== 1) throw new ConflictException(ALREADY_DECIDED);

      await tx.user.update({
        where: { id: profile.userId },
        data: {
          isActive: false,
        },
      });

      return tx.artisanProfile.findUnique({ where: { id: profileId } });
    });

    await this.addInternalNote({
      authorId: adminId,
      targetType: AdminNoteTargetType.ARTISAN,
      targetId: profileId,
      content: dto.note || 'Profil suspendu.',
    });

    return updated;
  }

  async reactivateArtisan(
    adminId: number,
    profileId: number,
    dto: AdminReviewArtisanDto,
  ) {
    const profile = await this.getArtisanDetail(profileId);

    // Only a suspended artisan comes back this way (see suspendArtisan).
    if (profile.verificationStatus !== ArtisanVerificationStatus.SUSPENDED) {
      throw new BadRequestException('Seul un artisan suspendu peut être réactivé.');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.artisanProfile.updateMany({
        where: { id: profileId, verificationStatus: ArtisanVerificationStatus.SUSPENDED },
        data: {
          verificationStatus: ArtisanVerificationStatus.APPROVED,
          rejectionReason: null,
          // the suspension switched missions off; reactivating gives them back
          isAcceptingJobs: true,
        },
      });

      if (claimed.count !== 1) throw new ConflictException(ALREADY_DECIDED);

      await tx.user.update({
        where: { id: profile.userId },
        data: {
          isActive: true,
          role: Role.ARTISAN,
        },
      });

      return tx.artisanProfile.findUnique({ where: { id: profileId } });
    });

    await this.addInternalNote({
      authorId: adminId,
      targetType: AdminNoteTargetType.ARTISAN,
      targetId: profileId,
      content: dto.note || 'Artisan réactivé.',
    });

    return updated;
  }

  async getArtisanMissions(profileId: number) {
    const profile = await this.getArtisanDetail(profileId);

    return this.prisma.intervention.findMany({
      where: {
        artisanId: profile.userId,
      },
      include: this.interventionInclude,
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async getArtisanRatings(profileId: number) {
    const profile = await this.getArtisanDetail(profileId);

    const [reviews, average] = await Promise.all([
      this.prisma.review.findMany({
        where: {
          artisanId: profile.userId,
        },
        include: {
          client: {
            select: this.safeUserSelect,
          },
          intervention: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
      }),

      this.prisma.review.aggregate({
        where: {
          artisanId: profile.userId,
        },
        _avg: {
          rating: true,
        },
        _count: {
          rating: true,
        },
      }),
    ]);

    return {
      averageRating: average._avg.rating || 0,
      count: average._count.rating,
      reviews,
    };
  }

  async getArtisanLocation(profileId: number) {
    const profile = await this.getArtisanDetail(profileId);
    const age = positionAge((profile.user as any).positionAt);

    return {
      artisanProfileId: profile.id,
      userId: profile.userId,
      latitude: profile.user.latitude,
      longitude: profile.user.longitude,
      // When the phone last said where it is, and whether that is too long ago (P3-05). `lastSeenAt` is the last sign of life of any kind
      // (the online switch counts), so it is not the age of the position.
      positionAt: (profile.user as any).positionAt ?? null,
      locationState: age.state,
      locationAgeMinutes: age.ageMinutes,
      lastSeenAt: profile.lastSeenAt,
      availabilityStatus: profile.availabilityStatus,
      isAcceptingJobs: profile.isAcceptingJobs,
    };
  }

  /** Where the technician went on a job, for a dispute (P3-05). */
  async getInterventionRoute(id: number, artisanId: number | null = null) {
    this.refuseUnknownJob(id);

    // A number the database could not hold is no technician (and would come back from it as an error, not as "not found").
    if (artisanId !== null && (!Number.isInteger(artisanId) || artisanId < 1 || artisanId > MAX_ROW_ID)) {
      throw new NotFoundException('Technicien introuvable.');
    }

    return routeOfJob(this.prisma, id, new Date(), artisanId);
  }

  async getArtisanRevenue(profileId: number) {
    const profile = await this.getArtisanDetail(profileId);

    const payments = await this.prisma.payment.findMany({
      where: {
        status: { in: PAID_PAYMENT_STATUSES },
        intervention: {
          artisanId: profile.userId,
        },
      },
      include: {
        intervention: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    // What the customers paid and kept: a payment that was partly given back counts for what is left of it.
    const totalRevenue = sumMoneyOf(payments.map((payment) => subtractMoney(money(payment.amount), money(payment.amountRefunded))));

    return {
      artisanProfileId: profileId,
      totalRevenue,
      payments,
    };
  }

  async addArtisanInternalNote(
    adminId: number,
    profileId: number,
    dto: AdminInternalNoteDto,
  ) {
    await this.getArtisanDetail(profileId);

    return this.addInternalNote({
      authorId: adminId,
      targetType: AdminNoteTargetType.ARTISAN,
      targetId: profileId,
      content: dto.content,
    });
  }

  // ==========================================================
  // 5. CLIENT MANAGEMENT
  // ==========================================================

  async findAllClients(query: AdminClientQueryDto) {
    const { page, limit, skip, take } = this.getPagination(
      query.page,
      query.limit,
    );

    const where: Prisma.UserWhereInput = {
      role: Role.CLIENT,
    };

    if (query.search) {
      where.OR = [
        {
          name: {
            contains: query.search,
            mode: 'insensitive',
          },
        },
        {
          email: {
            contains: query.search,
            mode: 'insensitive',
          },
        },
        {
          phone: {
            contains: query.search,
            mode: 'insensitive',
          },
        },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: this.safeUserSelect,
        orderBy: {
          createdAt: 'desc',
        },
        skip,
        take,
      }),

      this.prisma.user.count({
        where,
      }),
    ]);

    return paginated(data, page, limit, total);
  }

  async getClientDetail(clientId: number) {
    const client = await this.prisma.user.findUnique({
      where: { id: clientId },
      select: {
        ...this.safeUserSelect,
        clientAddresses: true,
        notificationPreference: true,
        clientInterventions: {
          include: this.interventionInclude,
          orderBy: {
            createdAt: 'desc',
          },
        },
        complaints: {
          orderBy: {
            createdAt: 'desc',
          },
        },
      },
    });

    if (!client || client.role !== Role.CLIENT) {
      throw new NotFoundException('Client introuvable.');
    }

    const payments = await this.prisma.payment.findMany({
      where: {
        intervention: {
          clientId,
        },
      },
      include: {
        intervention: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    const invoices = await this.prisma.invoice.findMany({
      where: {
        intervention: {
          clientId,
        },
      },
      include: {
        intervention: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    const internalNotes = await this.prisma.adminInternalNote.findMany({
      where: {
        targetType: AdminNoteTargetType.CLIENT,
        targetId: clientId,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return {
      ...client,
      payments,
      invoices,
      internalNotes,
    };
  }

  async editClient(clientId: number, dto: EditClientDto) {
    await this.getClientDetail(clientId);

    const current = await this.prisma.user.findUnique({
      where: { id: clientId },
      select: { id: true, name: true, email: true, phone: true, phoneKey: true },
    });

    if (!current) {
      throw new NotFoundException('Client introuvable.');
    }

    // Same rules as every other contact change: unique e-mail and phone,
    // verification flags reset, the old mailbox is told (ContactChangeService).
    const change = await this.contactChange.prepareAdminChange(current, {
      email: dto.email,
      phone: dto.phone,
    });

    // The change and the end of the links that went to the old address or number are one step.
    const updated = await this.prisma
      .$transaction(async (tx) => {
        const row = await tx.user.update({
          where: { id: clientId },
          data: {
            ...change.data,
            name: dto.name,
            address: dto.address,
          },
          select: this.safeUserSelect,
        });

        await this.contactChange.revokeAfterAdminChange(tx, clientId, change);

        return row;
      })
      .catch(rethrowContactConflict);

    await this.contactChange.noticeAfterAdminChange(current, change, updated);

    return updated;
  }

  async deactivateClient(clientId: number) {
    await this.getClientDetail(clientId);

    return this.prisma.user.update({
      where: { id: clientId },
      data: {
        isActive: false,
        deletedAt: new Date(),
        // The number is free again; the text stays on the row for the records.
        phoneKey: null,
      },
      select: this.safeUserSelect,
    });
  }

  async addClientInternalNote(
    adminId: number,
    clientId: number,
    dto: AdminInternalNoteDto,
  ) {
    await this.getClientDetail(clientId);

    return this.addInternalNote({
      authorId: adminId,
      targetType: AdminNoteTargetType.CLIENT,
      targetId: clientId,
      content: dto.content,
    });
  }

  // ==========================================================
  // 6. COMPLAINT CENTER
  // ==========================================================

  async findAllComplaints(query: AdminComplaintQueryDto, actorId: number | null = null) {
    const { page, limit, skip, take } = this.getPagination(
      query.page,
      query.limit,
    );

    // The list is read by the complaints screen (P2-09): the views, the search and the size of each view are worked out in
    // complaint-center.ts, which the specs run without a database.
    const { rows, total, counts } = await complaintList(this.prisma, query, actorId, { page, limit, skip, take });

    return { ...paginated(rows, page, limit, total), counts };
  }

  /** One complaint for the screen that handles it: the people, the job, the thread, the journal and the money of the job. */
  async getComplaintCase(complaintId: number) {
    return complaintCase(this.prisma, complaintId);
  }

  async getComplaintDetail(complaintId: number) {
    const complaint = await this.prisma.complaint.findUnique({
      where: { id: complaintId },
      include: {
        user: {
          select: this.safeUserSelect,
        },
        intervention: {
          include: this.interventionInclude,
        },
      },
    });

    if (!complaint) {
      throw new NotFoundException('Réclamation introuvable.');
    }

    const internalNotes = await this.prisma.adminInternalNote.findMany({
      where: {
        targetType: AdminNoteTargetType.COMPLAINT,
        targetId: complaintId,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return {
      ...complaint,
      internalNotes,
    };
  }

  async assignComplaint(
    adminId: number,
    complaintId: number,
    dto: AssignComplaintDto,
  ) {
    await this.getComplaintDetail(complaintId);

    const supportAgent = await this.prisma.user.findUnique({
      where: {
        id: dto.supportAgentId,
      },
    });

    if (
      !supportAgent ||
      !supportAgent.isActive ||
      supportAgent.deletedAt ||
      !this.isAssignableSupportRole(supportAgent.role)
    ) {
      throw new BadRequestException('Agent support invalide.');
    }

    const updated = await this.prisma.complaint.update({
      where: { id: complaintId },
      data: {
        assignedToId: dto.supportAgentId,
        status: ComplaintStatus.IN_REVIEW,
      },
    });

    await this.addInternalNote({
      authorId: adminId,
      targetType: AdminNoteTargetType.COMPLAINT,
      targetId: complaintId,
      content: `Réclamation assignée à ${supportAgent.name || supportAgent.email}.`,
    });

    return updated;
  }

  async updateComplaintStatus(
    adminId: number,
    complaintId: number,
    dto: UpdateComplaintStatusDto,
  ) {
    await this.getComplaintDetail(complaintId);

    const data = {
      status: dto.status,
      closedAt:
        dto.status === ComplaintStatus.RESOLVED ||
        dto.status === ComplaintStatus.REJECTED
          ? new Date()
          : undefined,
    };

    // Rejecting, resolving and refunding end a complaint (P2-09): not while the refund the customer asked for waits for an answer.
    if (endsComplaint(dto.status)) {
      await closeComplaintIfRefundAnswered(this.prisma, complaintId, data);
    } else {
      await this.prisma.complaint.update({ where: { id: complaintId }, data });
    }

    const updated = await this.prisma.complaint.findUnique({ where: { id: complaintId } });

    if (dto.note) {
      await this.addInternalNote({
        authorId: adminId,
        targetType: AdminNoteTargetType.COMPLAINT,
        targetId: complaintId,
        content: dto.note,
      });
    }

    return updated;
  }

  async addComplaintInternalNote(
    adminId: number,
    complaintId: number,
    dto: AdminInternalNoteDto,
  ) {
    await this.getComplaintDetail(complaintId);

    return this.addInternalNote({
      authorId: adminId,
      targetType: AdminNoteTargetType.COMPLAINT,
      targetId: complaintId,
      content: dto.content,
    });
  }

  async complaintContactClient(
    adminId: number,
    complaintId: number,
    dto: AdminContactDto,
  ) {
    const complaint = await this.getComplaintDetail(complaintId);

    return this.prisma.message.create({
      data: {
        interventionId: complaint.interventionId,
        senderId: adminId,
        audience: MessageAudience.CLIENT_SUPPORT,
        content: dto.content,
        attachments: dto.attachments || [],
      },
    });
  }

  async complaintContactArtisan(
    adminId: number,
    complaintId: number,
    dto: AdminContactDto,
  ) {
    const complaint = await this.getComplaintDetail(complaintId);

    if (!complaint.intervention.artisanId) {
      throw new BadRequestException(
        'Aucun artisan assigné à cette intervention.',
      );
    }

    return this.prisma.message.create({
      data: {
        interventionId: complaint.interventionId,
        senderId: adminId,
        audience: MessageAudience.ARTISAN_SUPPORT,
        content: dto.content,
        attachments: dto.attachments || [],
      },
    });
  }

  async decideRefund(
    adminId: number,
    complaintId: number,
    dto: DecideRefundDto,
  ) {
    const complaint = await this.getComplaintDetail(complaintId);

    // Under the lock of the job, as a refund of a payment is: the two cannot pass each other, so a complaint is never left
    // waiting for a refund that was made a moment before.
    const updated = await this.prisma.$transaction(async (tx) => {
      await lockJob(tx, complaint.interventionId);

      const current = await tx.complaint.findUnique({ where: { id: complaintId }, select: { refundDecision: true } });

      if (!current) throw new NotFoundException('Réclamation introuvable.');

      // A refund that was made settles the complaint: it cannot be turned into a refusal or an approval of another amount.
      if (REFUND_MADE_DECISIONS.includes(String(current.refundDecision))) {
        throw new ConflictException(REFUND_ALREADY_MADE);
      }

      const figures = paymentFigures(await tx.payment.findMany({ where: { interventionId: complaint.interventionId } }));

      // What is approved goes back out of what was received on the job: more than that could never be paid back, and the
      // complaint (and the payout of the job) would wait for ever.
      if (dto.approved && dto.amount !== undefined && compareMoney(figures.received, 0) > 0 && compareMoney(dto.amount, figures.received) > 0) {
        throw new BadRequestException(`Le montant approuvé dépasse ce qui a été encaissé sur cette mission (${formatMoney(figures.received)}).`);
      }

      const claimed = await tx.complaint.updateMany({
        where: { id: complaintId, refundDecision: { notIn: [...REFUND_MADE_DECISIONS] } },
        data: {
          // The decision itself is written too (it was left at PENDING): what the payouts and a later refund read.
          refundDecision: dto.approved ? ComplaintRefundDecision.APPROVED : ComplaintRefundDecision.REJECTED,
          refundApproved: dto.approved,
          refundAmount: dto.approved ? dto.amount : null,
          refundDecidedById: adminId,
          refundDecidedAt: new Date(),
          status: dto.approved
            ? ComplaintStatus.REFUNDED
            : ComplaintStatus.IN_REVIEW,
        },
      });

      if (claimed.count !== 1) throw new ConflictException(REFUND_ALREADY_MADE);

      // Money that already went back to the customer is the answer to an approval: the complaint is settled now, not at a
      // refund that will never come (the payment cannot be refunded twice).
      if (dto.approved && compareMoney(figures.refunded, 0) > 0) {
        await settleComplaintRefund(tx, complaint.interventionId, { userId: adminId }, figures, complaintId);
      }

      return tx.complaint.findUnique({ where: { id: complaintId } });
    });

    await this.addInternalNote({
      authorId: adminId,
      targetType: AdminNoteTargetType.COMPLAINT,
      targetId: complaintId,
      content:
        dto.note ||
        (dto.approved
          ? `Remboursement approuvé: ${formatMoney(dto.amount ?? 0)}.`
          : 'Remboursement refusé.'),
    });

    await this.createInterventionEvent({
      interventionId: complaint.interventionId,
      type: InterventionEventType.ISSUE_REPORTED,
      title: 'Décision remboursement',
      message: dto.approved
        ? `Remboursement approuvé: ${formatMoney(dto.amount ?? 0)}.`
        : 'Remboursement refusé.',
      createdById: adminId,
    });

    return updated;
  }

  async closeComplaint(
    adminId: number,
    complaintId: number,
    dto: AdminInternalNoteDto,
  ) {
    await this.getComplaintDetail(complaintId);

    await closeComplaintIfRefundAnswered(this.prisma, complaintId, {
      status: ComplaintStatus.RESOLVED,
      closedAt: new Date(),
    });

    const updated = await this.prisma.complaint.findUnique({ where: { id: complaintId } });

    await this.addInternalNote({
      authorId: adminId,
      targetType: AdminNoteTargetType.COMPLAINT,
      targetId: complaintId,
      content: dto.content || 'Réclamation clôturée.',
    });

    return updated;
  }

  // ==========================================================
  // 7. SETTINGS CENTER
  // ==========================================================

  async getCompanySettings() {
    const settings = await this.prisma.companySettings.findFirst({
      orderBy: {
        id: 'asc',
      },
    });

    if (settings) {
      // A row saved before the list of rates existed answers the list it stands for.
      return settings.taxRates === null || settings.taxRates === undefined ? { ...settings, taxRates: effectiveTaxRates(settings) as any } : settings;
    }

    const created = await this.prisma.companySettings.create({
      data: {
        companyName: 'Smart Dépannage',
        companyPhone: '',
        companyEmail: '',
        smsSender: 'SMARTDEP',
        currency: getLocale().currency,
        // What the server started with (BUSINESS_TIMEZONE, else Africa/Tunis): from now on the settings are the source.
        timezone: getBusinessTimeZone(),
        taxRates: DEFAULT_TAX_RATES.map((rate) => ({ ...rate })),
        defaultTaxRate: getLocale().defaultTaxRate,
        defaultEmergencyFee: 0,
        openingHours: {},
        paymentMethods: ['ONLINE', 'CASH', 'BANK_TRANSFER'],
      },
    });

    applyLocale(localeOfRow(created));

    return created;
  }

  async updateCompanySettings(dto: UpdateCompanySettingsDto) {
    const settings = await this.getCompanySettings();

    // The locale is checked as a whole before anything is written: the list of rates must hold the default rate.
    let taxRates: TaxRateOption[] | undefined;
    let rib: string | null | undefined;
    let matriculeFiscal: string | null | undefined;

    try {
      taxRates = dto.taxRates === undefined ? undefined : parseTaxRates(dto.taxRates);
      // An empty text, or null, clears the field.
      const ribText = dto.rib as string | null | undefined;
      const matriculeText = dto.matriculeFiscal as string | null | undefined;

      rib = ribText === undefined ? undefined : ribText === null || String(ribText).trim() === '' ? null : normalizeRib(String(ribText));
      matriculeFiscal = matriculeText === undefined ? undefined : matriculeText === null || String(matriculeText).trim() === '' ? null : normalizeMatriculeFiscal(String(matriculeText));

      resolveLocale(
        localeOfRow({
          currency: dto.currency ?? settings.currency,
          timezone: dto.timezone ?? settings.timezone,
          taxRates: taxRates ?? settings.taxRates,
          defaultTaxRate: dto.defaultTaxRate ?? settings.defaultTaxRate,
        }),
        DEFAULT_LOCALE,
      );
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Paramètres invalides.');
    }

    // The name of the company is the one thing an invoice cannot do without: it cannot be emptied (the other fields can).
    const companyName = dto.companyName === undefined ? undefined : String(dto.companyName ?? '').trim();

    if (companyName === '') {
      throw new BadRequestException('Le nom de l’entreprise ne peut pas être vide.');
    }

    // What the invoices print (P2-07): an empty text clears a field; the stamp duty is an amount that cannot be a typing error.
    const printedText = (value: unknown): string | null | undefined => (value === undefined ? undefined : value === null || String(value).trim() === '' ? null : String(value).trim());
    const companyAddress = printedText(dto.companyAddress);
    const registreCommerce = printedText(dto.registreCommerce);
    const invoiceLegalMentions = printedText(dto.invoiceLegalMentions);
    const paymentTerms = printedText(dto.paymentTerms);

    // The stamp duty cleared with null means none: 0 (the column cannot be empty).
    const stampDuty = dto.stampDuty === null ? 0 : dto.stampDuty;

    if (stampDuty !== undefined && compareMoney(money(stampDuty), STAMP_DUTY_MAX) > 0) {
      throw new BadRequestException(`Le timbre fiscal ne peut pas dépasser ${formatMoney(STAMP_DUTY_MAX, { currency: false })} : vérifiez le montant.`);
    }

    // The accountant's confirmation covers the values it was given for. A request that confirms says who; a request that changes
    // what an invoice prints without confirming again takes the confirmation away (the new values were not seen by the accountant).
    const confirming = dto.invoiceRulesConfirmed === true;
    const confirmer = typeof dto.invoiceRulesConfirmedBy === 'string' ? dto.invoiceRulesConfirmedBy.trim() : '';

    if (confirming && confirmer === '') {
      throw new BadRequestException('Indiquez qui a confirmé les mentions, les taux de TVA et le timbre fiscal (invoiceRulesConfirmedBy).');
    }

    // There is nothing to confirm on empty settings: an invoice must at least name the seller, say where it is and carry its tax number.
    if (confirming) {
      const after = (incoming: unknown, current: unknown): string => String((incoming === undefined ? current : incoming) ?? '').trim();
      const missing = [
        after(companyName, settings.companyName) === '' ? 'le nom de l’entreprise' : null,
        after(companyAddress, settings.companyAddress) === '' ? 'l’adresse' : null,
        after(matriculeFiscal, settings.matriculeFiscal) === '' ? 'le matricule fiscal' : null,
      ].filter(Boolean);

      if (missing.length > 0) {
        throw new BadRequestException(`Les mentions ne peuvent pas être confirmées : renseignez d’abord ${missing.length > 1 ? `${missing.slice(0, -1).join(', ')} et ${missing[missing.length - 1]}` : missing[0]}.`);
      }
    }

    if (!confirming && dto.invoiceRulesConfirmedBy !== undefined) {
      throw new BadRequestException('invoiceRulesConfirmedBy ne s’envoie qu’avec invoiceRulesConfirmed: true.');
    }

    const printedChanged = printedSettingsChanged(settings, {
      companyName,
      companyPhone: dto.companyPhone,
      companyEmail: dto.companyEmail,
      companyAddress,
      matriculeFiscal,
      registreCommerce,
      rib,
      invoiceLegalMentions,
      paymentTerms,
      stampDuty,
      taxRates,
      defaultTaxRate: dto.defaultTaxRate,
    });

    const confirmation = confirming
      ? { invoiceRulesConfirmedAt: new Date(), invoiceRulesConfirmedBy: confirmer }
      : dto.invoiceRulesConfirmed === false || (printedChanged && settings.invoiceRulesConfirmedAt)
        ? { invoiceRulesConfirmedAt: null, invoiceRulesConfirmedBy: null }
        : {};

    const updated = await this.prisma.companySettings.update({
      where: {
        id: settings.id,
      },
      data: {
        companyName,
        companyPhone: dto.companyPhone,
        companyEmail: dto.companyEmail,
        smsSender: dto.smsSender,
        currency: dto.currency,
        timezone: dto.timezone,
        taxRates: taxRates as any,
        defaultTaxRate: dto.defaultTaxRate,
        defaultEmergencyFee: dto.defaultEmergencyFee,
        rib,
        matriculeFiscal,
        companyAddress,
        registreCommerce,
        invoiceLegalMentions,
        paymentTerms,
        stampDuty,
        ...confirmation,
        openingHours: dto.openingHours as any,
        paymentMethods: dto.paymentMethods,
        termsAndConditions: dto.termsAndConditions,
        privacyPolicy: dto.privacyPolicy,
      },
    });

    // The server reads the new currency, time zone and rates from now on.
    applyLocale(localeOfRow(updated));

    return updated;
  }

  async findServiceZones() {
    return this.prisma.adminServiceZone.findMany({
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async createServiceZone(dto: CreateAdminServiceZoneDto) {
    return this.prisma.adminServiceZone.create({
      data: {
        name: dto.name,
        city: dto.city,
        postalCode: dto.postalCode,
        latitude: dto.latitude,
        longitude: dto.longitude,
        radiusKm: dto.radiusKm || 10,
        isActive: dto.isActive ?? true,
      },
    });
  }

  async updateServiceZone(zoneId: number, dto: UpdateAdminServiceZoneDto) {
    const zone = await this.prisma.adminServiceZone.findUnique({
      where: { id: zoneId },
    });

    if (!zone) {
      throw new NotFoundException('Zone introuvable.');
    }

    return this.prisma.adminServiceZone.update({
      where: { id: zoneId },
      data: dto,
    });
  }

  async deleteServiceZone(zoneId: number) {
    const zone = await this.prisma.adminServiceZone.findUnique({
      where: { id: zoneId },
    });

    if (!zone) {
      throw new NotFoundException('Zone introuvable.');
    }

    await this.prisma.adminServiceZone.delete({
      where: { id: zoneId },
    });

    return {
      message: 'Zone supprimée avec succès.',
    };
  }

  async updateServiceCategory(
    categoryId: number,
    dto: UpdateServiceCategoryPricingDto,
  ) {
    const category = await this.prisma.serviceCategory.findUnique({
      where: { id: categoryId },
    });

    if (!category) {
      throw new NotFoundException('Catégorie introuvable.');
    }

    return this.prisma.serviceCategory.update({
      where: { id: categoryId },
      data: dto,
    });
  }

  async updateSubServicePricing(
    subServiceId: number,
    dto: UpdateSubServicePricingDto,
  ) {
    const subService = await this.prisma.subService.findUnique({
      where: { id: subServiceId },
    });

    if (!subService) {
      throw new NotFoundException('Sous-service introuvable.');
    }

    return this.prisma.subService.update({
      where: { id: subServiceId },
      data: dto,
    });
  }

  async findNotificationTemplates() {
    return this.prisma.notificationTemplate.findMany({
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async createNotificationTemplate(dto: CreateNotificationTemplateDto) {
    const template = await this.prisma.notificationTemplate.create({
      data: {
        key: dto.key,
        type: dto.type,
        subject: dto.subject,
        content: dto.content,
        isActive: dto.isActive ?? true,
      },
    });

    // The wording is cached for a minute: the next message must use the new one.
    this.notifications.clearTemplateCache();

    return template;
  }

  async updateNotificationTemplate(
    templateId: number,
    dto: UpdateNotificationTemplateDto,
  ) {
    const template = await this.prisma.notificationTemplate.findUnique({
      where: { id: templateId },
    });

    if (!template) {
      throw new NotFoundException('Template introuvable.');
    }

    const updated = await this.prisma.notificationTemplate.update({
      where: { id: templateId },
      data: dto,
    });

    this.notifications.clearTemplateCache();

    return updated;
  }

  async deleteNotificationTemplate(templateId: number) {
    const template = await this.prisma.notificationTemplate.findUnique({
      where: { id: templateId },
    });

    if (!template) {
      throw new NotFoundException('Template introuvable.');
    }

    await this.prisma.notificationTemplate.delete({
      where: { id: templateId },
    });

    this.notifications.clearTemplateCache();

    return {
      message: 'Template supprimé avec succès.',
    };
  }
}
