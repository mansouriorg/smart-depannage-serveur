import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import * as argon2 from 'argon2';
import * as crypto from 'crypto';

import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { getFrontendUrl as getConfiguredFrontendUrl } from '../../config/env';
import { InterventionEventsService } from '../intervention-events/intervention-events.service';
import { statusesInGroup } from '../intervention-workflow/intervention-status';
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
  ArtisanVerificationStatus,
  AuthTokenType,
  ComplaintStatus,
  InterventionEventType,
  MessageAudience,
  NotificationChannel,
  PaymentStatus,
  Prisma,
  QuoteStatus,
  Role,
  Status,
} from '../../../generated/prisma/client';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly events: InterventionEventsService,
  ) {}

  // ==========================================================
  // 1. HELPERS
  // ==========================================================

  private getFrontendUrl(): string {
    return getConfiguredFrontendUrl();
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private generateRandomToken(): string {
    return crypto.randomBytes(32).toString('hex');
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
    const safePage = Math.max(1, Number(page || 1));
    const safeLimit = Math.min(100, Math.max(1, Number(limit || 20)));

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

  private async createPasswordSetupToken(userId: number): Promise<string> {
    const rawToken = this.generateRandomToken();

    await this.prisma.authToken.updateMany({
      where: {
        userId,
        type: AuthTokenType.PASSWORD_RESET,
        usedAt: null,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });

    await this.prisma.authToken.create({
      data: {
        userId,
        type: AuthTokenType.PASSWORD_RESET,
        tokenHash: this.hashToken(rawToken),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    return rawToken;
  }

  private async sendPasswordSetupEmail(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('Utilisateur introuvable.');
    }

    const rawToken = await this.createPasswordSetupToken(user.id);
    const setupUrl = `${this.getFrontendUrl()}/reset-password?token=${rawToken}`;

    // A setup link is a password-reset token that lives 24 h and revokes the
    // previous one: the message follows the same rules (see AuthService).
    await this.notifications.sendEmail(
      user.email,
      'Création de votre mot de passe',
      `Votre compte a été créé. Cliquez ici pour créer votre mot de passe: ${setupUrl}`,
      {
        userId: user.id,
        template: { key: 'auth.password_setup', vars: { name: user.name, link: setupUrl } },
        validForMs: 24 * 60 * 60 * 1000,
        replaces: `auth:PASSWORD_RESET:${user.id}`,
      },
    );

    if (user.phone) {
      await this.notifications.sendSms(
        user.phone,
        `Smart Dépannage: créez votre mot de passe ici: ${setupUrl}`,
        {
          userId: user.id,
          validForMs: 24 * 60 * 60 * 1000,
          replaces: `auth:PASSWORD_RESET_SMS:${user.id}`,
        },
      );
    }
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

  async findAllInterventions(query: AdminInterventionQueryDto) {
    const { page, limit, skip, take } = this.getPagination(
      query.page,
      query.limit,
    );

    const where: Prisma.InterventionWhereInput = {};

    if (query.status) {
      where.status = query.status;
    }

    if (query.serviceType) {
      where.serviceType = query.serviceType;
    }

    if (query.city) {
      where.address = {
        contains: query.city,
        mode: 'insensitive',
      };
    }

    if (query.artisanId) {
      where.artisanId = Number(query.artisanId);
    }

    if (query.dateFrom || query.dateTo) {
      where.createdAt = {
        gte: query.dateFrom ? new Date(query.dateFrom) : undefined,
        lte: query.dateTo ? new Date(query.dateTo) : undefined,
      };
    }

    if (query.search) {
      where.OR = [
        {
          contactName: {
            contains: query.search,
            mode: 'insensitive',
          },
        },
        {
          contactPhone: {
            contains: query.search,
            mode: 'insensitive',
          },
        },
        {
          contactEmail: {
            contains: query.search,
            mode: 'insensitive',
          },
        },
        {
          client: {
            name: {
              contains: query.search,
              mode: 'insensitive',
            },
          },
        },
        {
          client: {
            phone: {
              contains: query.search,
              mode: 'insensitive',
            },
          },
        },
        {
          client: {
            email: {
              contains: query.search,
              mode: 'insensitive',
            },
          },
        },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.intervention.findMany({
        where,
        include: this.interventionInclude,
        orderBy: {
          createdAt: 'desc',
        },
        skip,
        take,
      }),

      this.prisma.intervention.count({
        where,
      }),
    ]);

    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getInterventionDetail(id: number) {
    const intervention = await this.prisma.intervention.findUnique({
      where: { id },
      include: this.interventionInclude,
    });

    if (!intervention) {
      throw new NotFoundException('Intervention introuvable.');
    }

    const internalNotes = await this.prisma.adminInternalNote.findMany({
      where: {
        targetType: AdminNoteTargetType.INTERVENTION,
        targetId: id,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return {
      ...intervention,
      internalNotes,
    };
  }

  async assignArtisan(
    adminId: number,
    interventionId: number,
    dto: AssignArtisanDto,
  ) {
    const intervention = await this.prisma.intervention.findUnique({
      where: { id: interventionId },
    });

    if (!intervention) {
      throw new NotFoundException('Intervention introuvable.');
    }

    const artisanProfile = await this.prisma.artisanProfile.findUnique({
      where: {
        userId: dto.artisanId,
      },
      include: {
        user: true,
      },
    });

    if (!artisanProfile) {
      throw new NotFoundException('Profil artisan introuvable.');
    }

    if (
      artisanProfile.verificationStatus !==
      ArtisanVerificationStatus.APPROVED
    ) {
      throw new BadRequestException('Cet artisan n’est pas encore approuvé.');
    }

    // Allowed from the dispatcher queue and for re-assigning a job that has not
    // started; the status table in intervention-status.ts decides.
    const updated = await transitionStatus(this.prisma, {
      id: interventionId,
      to: Status.ASSIGNED,
      actor: { kind: 'staff', userId: adminId },
      data: { artisanId: dto.artisanId, assignedAt: new Date() },
      include: this.interventionInclude,
    });

    await this.createInterventionEvent({
      interventionId,
      type: InterventionEventType.ARTISAN_ASSIGNED,
      title: 'Artisan assigné',
      message: `Artisan assigné par l’administration.`,
      createdById: adminId,
    });

    await this.notifications.sendEmail(
      artisanProfile.user.email,
      'Nouvelle mission assignée',
      `Une nouvelle mission vous a été assignée. Intervention #${interventionId}.`,
    );

    if (artisanProfile.user.phone) {
      await this.notifications.sendSms(
        artisanProfile.user.phone,
        `Smart Dépannage: une nouvelle mission vous a été assignée (#${interventionId}).`,
      );
    }

    return updated;
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

    const { row: updated, changed } = await transitionStatusDetailed(
      this.prisma,
      {
        id: interventionId,
        to: dto.status,
        actor: { kind: 'staff', userId: adminId },
        include: this.interventionInclude,
      },
    );

    if (changed) {
      await this.createInterventionEvent({
        interventionId,
        type: InterventionEventType.ADMIN_REVIEWING,
        title: 'Statut modifié par admin',
        message: dto.note || `Nouveau statut: ${dto.status}`,
        createdById: adminId,
      });
    }

    return updated;
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

    const { row: updated, changed } = await transitionStatusDetailed(
      this.prisma,
      {
        id: interventionId,
        to: Status.CANCELLED,
        actor: { kind: 'staff', userId: adminId },
        dataOnChange: {
          cancelledReason: dto.reason,
          cancelledById: adminId,
          cancelledAt: new Date(),
        },
        include: this.interventionInclude,
      },
    );

    if (changed) {
      await this.createInterventionEvent({
        interventionId,
        type: InterventionEventType.CANCELLED,
        title: 'Intervention annulée',
        message: dto.reason,
        createdById: adminId,
      });
    }

    return updated;
  }

  async addInterventionInternalNote(
    adminId: number,
    interventionId: number,
    dto: AdminInternalNoteDto,
  ) {
    await this.getInterventionDetail(interventionId);

    return this.addInternalNote({
      authorId: adminId,
      targetType: AdminNoteTargetType.INTERVENTION,
      targetId: interventionId,
      content: dto.content,
    });
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

    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
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

  async createArtisanManually(
    adminId: number,
    dto: CreateArtisanManualDto,
  ) {
    const email = this.normalizeEmail(dto.email);

    const existingUser = await this.prisma.user.findFirst({
      where: {
        OR: [{ email }, { phone: dto.phone }],
      },
    });

    if (existingUser) {
      throw new BadRequestException(
        'Un utilisateur existe déjà avec cet email ou téléphone.',
      );
    }

    const hashedPassword = await argon2.hash(this.generateUnusablePassword());

    const profile = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          phone: dto.phone,
          name: dto.name,
          password: hashedPassword,
          role: Role.ARTISAN,
          isActive: true,
        },
      });

      return tx.artisanProfile.create({
        data: {
          userId: user.id,
          specialty: dto.specialty,
          specialties: dto.specialties,
          yearsExperience: dto.yearsExperience,
          companyName: dto.companyName,
          companyNumber: dto.companyNumber,
          insuranceNumber: dto.insuranceNumber,
          bio: dto.bio,
          profilePhotoUrl: dto.profilePhotoUrl,
          verificationStatus: ArtisanVerificationStatus.APPROVED,
          verifiedAt: new Date(),
          verifiedById: adminId,
        },
        include: {
          user: {
            select: this.safeUserSelect,
          },
        },
      });
    });

    await this.sendPasswordSetupEmail(profile.userId);

    return {
      message: 'Artisan créé manuellement avec succès.',
      profile,
    };
  }

  async editArtisanProfile(profileId: number, dto: EditArtisanProfileDto) {
    await this.getArtisanDetail(profileId);

    return this.prisma.artisanProfile.update({
      where: { id: profileId },
      data: dto,
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

  async approveArtisan(
    adminId: number,
    profileId: number,
    dto: AdminReviewArtisanDto,
  ) {
    const profile = await this.getArtisanDetail(profileId);

    const updated = await this.prisma.$transaction(async (tx) => {
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

      return tx.artisanProfile.update({
        where: { id: profileId },
        data: {
          verificationStatus: ArtisanVerificationStatus.APPROVED,
          rejectionReason: null,
          verifiedAt: new Date(),
          verifiedById: adminId,
        },
        include: {
          user: {
            select: this.safeUserSelect,
          },
          documents: true,
        },
      });
    });

    await this.sendPasswordSetupEmail(profile.userId);

    if (dto.note) {
      await this.addInternalNote({
        authorId: adminId,
        targetType: AdminNoteTargetType.ARTISAN,
        targetId: profileId,
        content: dto.note,
      });
    }

    return updated;
  }

  async rejectArtisan(
    adminId: number,
    profileId: number,
    dto: AdminReviewArtisanDto,
  ) {
    const profile = await this.getArtisanDetail(profileId);

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: profile.userId },
        data: {
          isActive: false,
        },
      });

      return tx.artisanProfile.update({
        where: { id: profileId },
        data: {
          verificationStatus: ArtisanVerificationStatus.REJECTED,
          rejectionReason: dto.note || 'Candidature refusée.',
        },
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
      dto.note || 'Votre candidature artisan a été refusée.',
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

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: profile.userId },
        data: {
          isActive: false,
        },
      });

      return tx.artisanProfile.update({
        where: { id: profileId },
        data: {
          verificationStatus: ArtisanVerificationStatus.SUSPENDED,
          rejectionReason: dto.note || 'Profil suspendu.',
          availabilityStatus: ArtisanAvailabilityStatus.UNAVAILABLE,
          isAcceptingJobs: false,
        },
      });
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

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: profile.userId },
        data: {
          isActive: true,
          role: Role.ARTISAN,
        },
      });

      return tx.artisanProfile.update({
        where: { id: profileId },
        data: {
          verificationStatus: ArtisanVerificationStatus.APPROVED,
          rejectionReason: null,
        },
      });
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

    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
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

    if (dto.email) {
      const existingEmail = await this.prisma.user.findUnique({
        where: {
          email: this.normalizeEmail(dto.email),
        },
      });

      if (existingEmail && existingEmail.id !== clientId) {
        throw new BadRequestException('Cet email est déjà utilisé.');
      }
    }

    return this.prisma.user.update({
      where: { id: clientId },
      data: {
        email: dto.email ? this.normalizeEmail(dto.email) : undefined,
        name: dto.name,
        phone: dto.phone,
        address: dto.address,
      },
      select: this.safeUserSelect,
    });
  }

  async deactivateClient(clientId: number) {
    await this.getClientDetail(clientId);

    return this.prisma.user.update({
      where: { id: clientId },
      data: {
        isActive: false,
        deletedAt: new Date(),
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

    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
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
