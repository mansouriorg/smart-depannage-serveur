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
import {
  interventionListSelect,
  interventionQueueOrder,
  interventionQueueWhere,
} from './intervention-queue';
import { tradeFieldsFor, tradeFieldsForEdit } from '../artisans/trade-fields';
import { InviteReason, inviteArtisan } from '../auth/invite';
import { artisanZoneRowsFor } from '../service-zones/zone-pick';
import { isStoredFileUrl } from '../files/stored-file-url';
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

/** The last page the list can be asked for: with 100 rows a page, the offset stays far below what the database holds. */
const MAX_PAGE = 1_000_000;

/** The largest job number the database stores (a 32-bit integer): a bigger one is no job's, and asking for it would be a database error. */
const MAX_ROW_ID = 2_147_483_647;

/** The answer when someone else decided the same profile first. */
const ALREADY_DECIDED = 'Ce profil vient d’être traité par un autre membre de l’équipe: rechargez la liste.';

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
    const allowedRoles: Role[] = [
      Role.SUPPORT,
      Role.ADMIN,
      Role.SUPER_ADMIN,
    ];

    return allowedRoles.includes(role);
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
    invoice: true,
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

    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

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
          status: PaymentStatus.PAID,
          createdAt: {
            gte: startOfMonth,
          },
        },
        _sum: {
          amount: true,
        },
      }),

      this.prisma.payment.aggregate({
        where: {
          status: PaymentStatus.PAID,
          createdAt: {
            gte: startOfToday,
          },
        },
        _sum: {
          amount: true,
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
      monthlyRevenue: monthlyRevenue._sum.amount || 0,
      todayRevenue: todayRevenue._sum.amount || 0,
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
   * the older route (the technician accepted; the job is done) and, for a cancellation, the notice to
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

    if (now === 'ARTISAN_ACCEPTED' && phone) {
      await attempt('text to the customer', () =>
        this.notifications.sendSms(
          phone,
          `Smart Dépannage: Votre demande a été acceptée ! ${row.artisan?.name || 'Un artisan'} prend en charge votre dossier.`,
        ),
      );
    }

    if (now === 'COMPLETED' && phone) {
      await attempt('text to the customer', () => this.notifications.sendSms(phone, 'Intervention terminée. Merci de votre confiance !'));
    }

    if (cancelled && typeof row.artisanId === 'number') {
      await attempt('notice to the technician', () =>
        this.notifications.notify({
          recipientId: row.artisanId,
          actorId: adminId,
          type: NotificationType.GENERAL,
          title: 'Mission annulée',
          message: `La mission #${row.id} a été annulée: ${cancelled.reason}`,
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
    const { row: updated, changed } = await this.prisma.$transaction(async (tx) => {
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

      if (result.changed) await cancelVisit(tx as any, interventionId, reason, adminId);

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

      await this.tellAboutStatusChange(String(intervention.status), updated, adminId, { reason });
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

    const amountHT = dto.items.reduce((sum, item) => {
      return sum + item.quantity * item.unitPrice;
    }, 0);

    const taxRate = dto.taxRate ?? 20;
    const taxAmount = Math.round(amountHT * (taxRate / 100) * 100) / 100;
    const amountTTC = Math.round((amountHT + taxAmount) * 100) / 100;

    const quote = await this.prisma.quote.create({
      data: {
        interventionId,
        createdById: adminId,
        title: dto.title,
        description: dto.description,
        amountHT,
        taxRate,
        taxAmount,
        amountTTC,
        status: QuoteStatus.SENT,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
        items: {
          create: dto.items.map((item) => ({
            label: item.label,
            description: item.description,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            total: Math.round(item.quantity * item.unitPrice * 100) / 100,
          })),
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
      message: `Devis envoyé par l’administration: ${amountTTC} € TTC.`,
      createdById: adminId,
    });

    if (intervention.contactPhone || intervention.client.phone) {
      await this.notifications.sendSms(
        intervention.contactPhone || intervention.client.phone!,
        `Smart Dépannage: vous avez reçu un devis de ${amountTTC} € TTC.`,
      );
    }

    if (intervention.contactEmail || intervention.client.email) {
      await this.notifications.sendEmail(
        intervention.contactEmail || intervention.client.email,
        'Votre devis Smart Dépannage',
        `Vous avez reçu un devis de ${amountTTC} € TTC.`,
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

    await this.notifications.sendEmail(
      profile.user.email,
      'Candidature artisan refusée',
      `Votre candidature artisan n’a pas été retenue.\n\nMotif: ${reason}`,
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

    return {
      artisanProfileId: profile.id,
      userId: profile.userId,
      latitude: profile.user.latitude,
      longitude: profile.user.longitude,
      lastSeenAt: profile.lastSeenAt,
      availabilityStatus: profile.availabilityStatus,
      isAcceptingJobs: profile.isAcceptingJobs,
    };
  }

  async getArtisanRevenue(profileId: number) {
    const profile = await this.getArtisanDetail(profileId);

    const payments = await this.prisma.payment.findMany({
      where: {
        status: PaymentStatus.PAID,
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

    const totalRevenue = payments.reduce(
      (sum, payment) => sum + payment.amount,
      0,
    );

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

  async findAllComplaints(query: AdminComplaintQueryDto) {
    const { page, limit, skip, take } = this.getPagination(
      query.page,
      query.limit,
    );

    const where: Prisma.ComplaintWhereInput = {};

    if (query.status) {
      where.status = query.status;
    }

    if (query.assignedToId) {
      where.assignedToId = Number(query.assignedToId);
    }

    if (query.search) {
      where.OR = [
        {
          title: {
            contains: query.search,
            mode: 'insensitive',
          },
        },
        {
          description: {
            contains: query.search,
            mode: 'insensitive',
          },
        },
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
            phone: {
              contains: query.search,
              mode: 'insensitive',
            },
          },
        },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.complaint.findMany({
        where,
        include: {
          user: {
            select: this.safeUserSelect,
          },
          intervention: {
            include: this.interventionInclude,
          },
        },
        orderBy: {
          createdAt: 'desc',
        },
        skip,
        take,
      }),

      this.prisma.complaint.count({
        where,
      }),
    ]);

    return paginated(data, page, limit, total);
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

    const updated = await this.prisma.complaint.update({
      where: { id: complaintId },
      data: {
        status: dto.status,
        closedAt:
          dto.status === ComplaintStatus.RESOLVED ||
          dto.status === ComplaintStatus.REJECTED
            ? new Date()
            : undefined,
      },
    });

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

    const updated = await this.prisma.complaint.update({
      where: { id: complaintId },
      data: {
        refundApproved: dto.approved,
        refundAmount: dto.approved ? dto.amount : null,
        refundDecidedAt: new Date(),
        status: dto.approved
          ? ComplaintStatus.REFUNDED
          : ComplaintStatus.IN_REVIEW,
      },
    });

    await this.addInternalNote({
      authorId: adminId,
      targetType: AdminNoteTargetType.COMPLAINT,
      targetId: complaintId,
      content:
        dto.note ||
        (dto.approved
          ? `Remboursement approuvé: ${dto.amount || 0} €.`
          : 'Remboursement refusé.'),
    });

    await this.createInterventionEvent({
      interventionId: complaint.interventionId,
      type: InterventionEventType.ISSUE_REPORTED,
      title: 'Décision remboursement',
      message: dto.approved
        ? `Remboursement approuvé: ${dto.amount || 0} €.`
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

    const updated = await this.prisma.complaint.update({
      where: { id: complaintId },
      data: {
        status: ComplaintStatus.RESOLVED,
        closedAt: new Date(),
      },
    });

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
      return settings;
    }

    return this.prisma.companySettings.create({
      data: {
        companyName: 'Smart Dépannage',
        companyPhone: '',
        companyEmail: '',
        smsSender: 'SMARTDEP',
        defaultTaxRate: 20,
        defaultEmergencyFee: 0,
        openingHours: {},
        paymentMethods: ['ONLINE', 'CASH', 'BANK_TRANSFER'],
      },
    });
  }

  async updateCompanySettings(dto: UpdateCompanySettingsDto) {
    const settings = await this.getCompanySettings();

    return this.prisma.companySettings.update({
      where: {
        id: settings.id,
      },
      data: {
        companyName: dto.companyName,
        companyPhone: dto.companyPhone,
        companyEmail: dto.companyEmail,
        smsSender: dto.smsSender,
        defaultTaxRate: dto.defaultTaxRate,
        defaultEmergencyFee: dto.defaultEmergencyFee,
        openingHours: dto.openingHours as any,
        paymentMethods: dto.paymentMethods,
        termsAndConditions: dto.termsAndConditions,
        privacyPolicy: dto.privacyPolicy,
      },
    });
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
