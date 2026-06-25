import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import * as argon2 from 'argon2';
import * as crypto from 'crypto';

import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { InterventionEventsService } from '../intervention-events/intervention-events.service';

import { ApplyArtisanDto } from './dto/apply-artisan.dto';
import { UpdateArtisanProfileDto } from './dto/update-artisan-profile.dto';
import { UploadArtisanDocumentDto } from './dto/upload-artisan-document.dto';
import { CreateServiceZoneDto } from './dto/create-service-zone.dto';
import { UpdateAvailabilityDto } from './dto/update-availability.dto';
import { UpdateBankDetailsDto } from './dto/update-bank-details.dto';
import { UpdateArtisanLocationDto } from './dto/update-artisan-location.dto';
import { RejectMissionDto } from './dto/reject-mission.dto';
import { UploadProofPhotoDto } from './dto/upload-proof-photo.dto';
import { AddDiagnosticDto } from './dto/add-diagnostic.dto';
import { AddMaterialUsedDto } from './dto/add-material-used.dto';
import { RequestExtraQuoteDto } from './dto/request-extra-quote.dto';
import { CollectSignatureDto } from './dto/collect-signature.dto';
import { ReportProblemDto } from './dto/report-problem.dto';
import { ContactMessageDto } from './dto/contact-message.dto';
import { AdminReviewArtisanDto } from './dto/admin-review-artisan.dto';

import {
  ArtisanAvailabilityStatus,
  ArtisanDocumentStatus,
  ArtisanDocumentType,
  ArtisanVerificationStatus,
  AuthTokenType,
  InterventionEventType,
  MessageAudience,
  Prisma,
  Role,
  Status,
} from '../../../generated/prisma/client';

@Injectable()
export class ArtisansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly events: InterventionEventsService,
  ) {}

  // ==========================================================
  // 1. HELPERS
  // ==========================================================

  private getFrontendUrl(): string {
    return process.env.FRONTEND_URL || 'http://localhost:3000';
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private generateRandomToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  private generateTemporaryPassword(): string {
    return `Artisan-Unusable-${crypto.randomBytes(64).toString('hex')}`;
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private normalizePhone(phone?: string): string | undefined {
    return phone?.trim() || undefined;
  }

  private canAcceptMissionStatus(status: Status): boolean {
    const allowedStatuses: Status[] = [
      Status.PENDING,
      Status.ADMIN_REVIEW,
      Status.QUOTE_ACCEPTED,
      Status.ASSIGNED,
    ];

    return allowedStatuses.includes(status);
  }

  private safeUserSelect = {
    id: true,
    email: true,
    name: true,
    phone: true,
    role: true,
    latitude: true,
    longitude: true,
    isActive: true,
    createdAt: true,
    updatedAt: true,
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

    await this.notifications.sendEmail(
      user.email,
      'Votre compte artisan est approuvé',
      `Votre compte artisan a été approuvé. Créez votre mot de passe ici: ${setupUrl}`,
    );

    if (user.phone) {
      await this.notifications.sendSms(
        user.phone,
        `Smart Dépannage: votre compte artisan est approuvé. Créez votre mot de passe: ${setupUrl}`,
      );
    }
  }

  private async getArtisanProfileByUserId(userId: number) {
    const profile = await this.prisma.artisanProfile.findUnique({
      where: { userId },
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

    if (!profile) {
      throw new NotFoundException('Profil artisan introuvable.');
    }

    return profile;
  }

  private async ensureApprovedArtisan(userId: number) {
    const profile = await this.getArtisanProfileByUserId(userId);

    if (profile.verificationStatus !== ArtisanVerificationStatus.APPROVED) {
      throw new ForbiddenException(
        'Votre profil artisan doit être approuvé pour effectuer cette action.',
      );
    }

    return profile;
  }

  private async getMissionForArtisan(
    artisanUserId: number,
    interventionId: number,
    options?: {
      allowUnassigned?: boolean;
    },
  ) {
    const intervention = await this.prisma.intervention.findUnique({
      where: { id: interventionId },
      include: {
        client: {
          select: {
            id: true,
            name: true,
            phone: true,
            email: true,
          },
        },
        artisan: {
          select: {
            id: true,
            name: true,
            phone: true,
          },
        },
        subService: true,
      },
    });

    if (!intervention) {
      throw new NotFoundException('Mission introuvable.');
    }

    const isAssignedToArtisan = intervention.artisanId === artisanUserId;
    const isUnassigned = !intervention.artisanId;

    if (!isAssignedToArtisan) {
      if (!(options?.allowUnassigned && isUnassigned)) {
        throw new ForbiddenException('Cette mission ne vous est pas attribuée.');
      }
    }

    return intervention;
  }

  private async createMissionEvent(data: {
    interventionId: number;
    type: InterventionEventType;
    title: string;
    message?: string;
    createdById?: number;
    metadata?: Prisma.InputJsonValue;
  }) {
    return this.events.create(data);
  }

  private calculateDistanceKm(
    lat1?: number | null,
    lng1?: number | null,
    lat2?: number | null,
    lng2?: number | null,
  ): number | null {
    if (
      lat1 === null ||
      lat1 === undefined ||
      lng1 === null ||
      lng1 === undefined ||
      lat2 === null ||
      lat2 === undefined ||
      lng2 === null ||
      lng2 === undefined
    ) {
      return null;
    }

    const earthRadiusKm = 6371;
    const dLat = this.toRadians(lat2 - lat1);
    const dLng = this.toRadians(lng2 - lng1);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRadians(lat1)) *
        Math.cos(this.toRadians(lat2)) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return Math.round(earthRadiusKm * c * 100) / 100;
  }

  private toRadians(value: number): number {
    return (value * Math.PI) / 180;
  }

  private estimateEtaMinutes(distanceKm: number | null): number | null {
    if (distanceKm === null) {
      return null;
    }

    const averageCitySpeedKmH = 25;
    return Math.max(1, Math.round((distanceKm / averageCitySpeedKmH) * 60));
  }

  private navigationUrl(intervention: {
    latitude?: number | null;
    longitude?: number | null;
    address: string;
  }): string {
    if (intervention.latitude && intervention.longitude) {
      return `https://www.google.com/maps/dir/?api=1&destination=${intervention.latitude},${intervention.longitude}`;
    }

    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
      intervention.address,
    )}`;
  }

  private async decorateMissionWithDistance(
    artisanUserId: number,
    mission: any,
  ) {
    const artisan = await this.prisma.user.findUnique({
      where: { id: artisanUserId },
      select: {
        latitude: true,
        longitude: true,
      },
    });

    const distanceKm = this.calculateDistanceKm(
      artisan?.latitude,
      artisan?.longitude,
      mission.latitude,
      mission.longitude,
    );

    return {
      ...mission,
      distanceKm,
      etaMinutes: this.estimateEtaMinutes(distanceKm),
      navigationUrl: this.navigationUrl(mission),
    };
  }

  // ==========================================================
  // 2. ARTISAN ONBOARDING
  // ==========================================================

  async apply(dto: ApplyArtisanDto) {
    const email = this.normalizeEmail(dto.email);
    const phone = this.normalizePhone(dto.phone);

    const existingUser = await this.prisma.user.findFirst({
      where: {
        OR: [{ email }, phone ? { phone } : undefined].filter(Boolean) as any[],
      },
      include: {
        artisanProfile: true,
      },
    });

    if (existingUser?.artisanProfile) {
      throw new BadRequestException(
        'Une candidature artisan existe déjà pour cet utilisateur.',
      );
    }

    if (existingUser && existingUser.role !== Role.ARTISAN) {
      throw new BadRequestException(
        'Un compte existe déjà avec cet email ou téléphone.',
      );
    }

    const hashedPassword = await argon2.hash(this.generateTemporaryPassword());

    const result = await this.prisma.$transaction(async (tx) => {
      const user =
        existingUser ||
        (await tx.user.create({
          data: {
            email,
            phone,
            name: dto.name,
            password: hashedPassword,
            role: Role.ARTISAN,
            isActive: false,
          },
        }));

      const profile = await tx.artisanProfile.create({
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
          verificationStatus: ArtisanVerificationStatus.PENDING_REVIEW,
        },
        include: {
          user: {
            select: this.safeUserSelect,
          },
        },
      });

      if (dto.identityDocumentUrl) {
        await tx.artisanDocument.create({
          data: {
            artisanProfileId: profile.id,
            type: ArtisanDocumentType.IDENTITY,
            fileUrl: dto.identityDocumentUrl,
          },
        });
      }

      if (dto.companyDocumentUrl) {
        await tx.artisanDocument.create({
          data: {
            artisanProfileId: profile.id,
            type: ArtisanDocumentType.COMPANY_LEGAL,
            fileUrl: dto.companyDocumentUrl,
          },
        });
      }

      if (dto.insuranceCertificateUrl) {
        await tx.artisanDocument.create({
          data: {
            artisanProfileId: profile.id,
            type: ArtisanDocumentType.INSURANCE,
            fileUrl: dto.insuranceCertificateUrl,
          },
        });
      }

      if (dto.profilePhotoUrl) {
        await tx.artisanDocument.create({
          data: {
            artisanProfileId: profile.id,
            type: ArtisanDocumentType.PROFILE_PHOTO,
            fileUrl: dto.profilePhotoUrl,
            status: ArtisanDocumentStatus.APPROVED,
          },
        });
      }

      if (dto.serviceAreas?.length) {
        await tx.artisanServiceZone.createMany({
          data: dto.serviceAreas.map((area) => ({
            artisanProfileId: profile.id,
            label: area,
            city: area,
            isActive: true,
          })),
        });
      }

      return profile;
    });

    await this.notifications.sendEmail(
      email,
      'Candidature artisan reçue',
      'Votre candidature artisan a bien été reçue. Notre équipe va l’examiner.',
    );

    if (phone) {
      await this.notifications.sendSms(
        phone,
        'Smart Dépannage: votre candidature artisan a bien été reçue.',
      );
    }

    return {
      message: 'Candidature artisan envoyée avec succès.',
      profile: result,
    };
  }

  // ==========================================================
  // 3. ARTISAN PROFILE
  // ==========================================================

  async getMyProfile(userId: number) {
    return this.getArtisanProfileByUserId(userId);
  }

  async updateMyProfile(userId: number, dto: UpdateArtisanProfileDto) {
    const profile = await this.getArtisanProfileByUserId(userId);

    return this.prisma.artisanProfile.update({
      where: { id: profile.id },
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

  async uploadDocument(userId: number, dto: UploadArtisanDocumentDto) {
    const profile = await this.getArtisanProfileByUserId(userId);

    return this.prisma.artisanDocument.create({
      data: {
        artisanProfileId: profile.id,
        type: dto.type,
        fileUrl: dto.fileUrl,
        fileName: dto.fileName,
        mimeType: dto.mimeType,
        status:
          dto.type === ArtisanDocumentType.PROFILE_PHOTO
            ? ArtisanDocumentStatus.APPROVED
            : ArtisanDocumentStatus.PENDING,
      },
    });
  }

  async addServiceZone(userId: number, dto: CreateServiceZoneDto) {
    const profile = await this.getArtisanProfileByUserId(userId);

    return this.prisma.artisanServiceZone.create({
      data: {
        artisanProfileId: profile.id,
        label: dto.label,
        city: dto.city,
        postalCode: dto.postalCode,
        latitude: dto.latitude,
        longitude: dto.longitude,
        radiusKm: dto.radiusKm || 10,
        isActive: dto.isActive ?? true,
      },
    });
  }

  async removeServiceZone(userId: number, zoneId: number) {
    const profile = await this.getArtisanProfileByUserId(userId);

    const zone = await this.prisma.artisanServiceZone.findUnique({
      where: { id: zoneId },
    });

    if (!zone || zone.artisanProfileId !== profile.id) {
      throw new NotFoundException('Zone introuvable.');
    }

    await this.prisma.artisanServiceZone.delete({
      where: { id: zoneId },
    });

    return {
      message: 'Zone supprimée avec succès.',
    };
  }

  async updateAvailability(userId: number, dto: UpdateAvailabilityDto) {
    const profile = await this.getArtisanProfileByUserId(userId);

    const updated = await this.prisma.$transaction(async (tx) => {
      const updatedProfile = await tx.artisanProfile.update({
        where: { id: profile.id },
        data: {
          availabilityStatus: dto.availabilityStatus,
          isAcceptingJobs: dto.isAcceptingJobs,
        },
      });

      if (dto.slots) {
        await tx.artisanAvailabilitySlot.deleteMany({
          where: { artisanProfileId: profile.id },
        });

        if (dto.slots.length) {
          await tx.artisanAvailabilitySlot.createMany({
            data: dto.slots.map((slot) => ({
              artisanProfileId: profile.id,
              dayOfWeek: slot.dayOfWeek,
              startTime: slot.startTime,
              endTime: slot.endTime,
              isAvailable: slot.isAvailable ?? true,
            })),
          });
        }
      }

      return updatedProfile;
    });

    return this.getArtisanProfileByUserId(updated.userId);
  }

  async updateBankDetails(userId: number, dto: UpdateBankDetailsDto) {
    const profile = await this.getArtisanProfileByUserId(userId);

    return this.prisma.artisanBankDetails.upsert({
      where: {
        artisanProfileId: profile.id,
      },
      create: {
        artisanProfileId: profile.id,
        accountHolderName: dto.accountHolderName,
        bankName: dto.bankName,
        iban: dto.iban,
        bic: dto.bic,
      },
      update: {
        accountHolderName: dto.accountHolderName,
        bankName: dto.bankName,
        iban: dto.iban,
        bic: dto.bic,
        isVerified: false,
      },
    });
  }

  // ==========================================================
  // 4. ARTISAN LOCATION / LIVE GPS
  // ==========================================================

  async updateLocation(userId: number, dto: UpdateArtisanLocationDto) {
    const profile = await this.getArtisanProfileByUserId(userId);

    const [user, artisanProfile] = await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: {
          latitude: dto.latitude,
          longitude: dto.longitude,
        },
        select: this.safeUserSelect,
      }),

      this.prisma.artisanProfile.update({
        where: { id: profile.id },
        data: {
          lastSeenAt: new Date(),
          availabilityStatus:
            dto.availabilityStatus || ArtisanAvailabilityStatus.ONLINE,
          isAcceptingJobs: dto.isAcceptingJobs ?? profile.isAcceptingJobs,
        },
      }),
    ]);

    return {
      user,
      artisanProfile,
      message: 'Position mise à jour.',
    };
  }

  async setOnline(userId: number) {
    const profile = await this.getArtisanProfileByUserId(userId);

    return this.prisma.artisanProfile.update({
      where: { id: profile.id },
      data: {
        availabilityStatus: ArtisanAvailabilityStatus.ONLINE,
        isAcceptingJobs: true,
        lastSeenAt: new Date(),
      },
    });
  }

  async setOffline(userId: number) {
    const profile = await this.getArtisanProfileByUserId(userId);

    return this.prisma.artisanProfile.update({
      where: { id: profile.id },
      data: {
        availabilityStatus: ArtisanAvailabilityStatus.OFFLINE,
        isAcceptingJobs: false,
        lastSeenAt: new Date(),
      },
    });
  }

  // ==========================================================
  // 5. MISSION BOARD
  // ==========================================================

  async getMissionBoard(userId: number) {
    const profile = await this.ensureApprovedArtisan(userId);

    const specialties = profile.specialties || [];

    const availableWhere: Prisma.InterventionWhereInput = {
      artisanId: null,
      status: {
        in: [
          Status.PENDING,
          Status.ADMIN_REVIEW,
          Status.QUOTE_ACCEPTED,
        ],
      },
    };

    if (specialties.length) {
      availableWhere.serviceType = {
        in: specialties as any,
      };
    }

    const [
      availableJobs,
      assignedJobs,
      acceptedJobs,
      activeJobs,
      completedJobs,
      cancelledJobs,
    ] = await Promise.all([
      this.prisma.intervention.findMany({
        where: availableWhere,
        include: this.missionInclude(),
        orderBy: { createdAt: 'desc' },
      }),

      this.prisma.intervention.findMany({
        where: {
          artisanId: userId,
          status: Status.ASSIGNED,
        },
        include: this.missionInclude(),
        orderBy: { createdAt: 'desc' },
      }),

      this.prisma.intervention.findMany({
        where: {
          artisanId: userId,
          status: Status.ACCEPTED,
        },
        include: this.missionInclude(),
        orderBy: { createdAt: 'desc' },
      }),

      this.prisma.intervention.findMany({
        where: {
          artisanId: userId,
          status: {
            in: [Status.ON_THE_WAY, Status.ARRIVED, Status.IN_PROGRESS],
          },
        },
        include: this.missionInclude(),
        orderBy: { createdAt: 'desc' },
      }),

      this.prisma.intervention.findMany({
        where: {
          artisanId: userId,
          status: {
            in: [Status.COMPLETED, Status.PAID, Status.INVOICE_READY],
          },
        },
        include: this.missionInclude(),
        orderBy: { createdAt: 'desc' },
      }),

      this.prisma.intervention.findMany({
        where: {
          artisanId: userId,
          status: Status.CANCELLED,
        },
        include: this.missionInclude(),
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      availableJobs: await Promise.all(
        availableJobs.map((job) =>
          this.decorateMissionWithDistance(userId, job),
        ),
      ),
      assignedJobs: await Promise.all(
        assignedJobs.map((job) =>
          this.decorateMissionWithDistance(userId, job),
        ),
      ),
      acceptedJobs: await Promise.all(
        acceptedJobs.map((job) =>
          this.decorateMissionWithDistance(userId, job),
        ),
      ),
      activeJobs: await Promise.all(
        activeJobs.map((job) =>
          this.decorateMissionWithDistance(userId, job),
        ),
      ),
      completedJobs,
      cancelledJobs,
    };
  }

  async getMissionDetails(userId: number, interventionId: number) {
    await this.ensureApprovedArtisan(userId);

    const mission = await this.getMissionForArtisan(userId, interventionId, {
      allowUnassigned: true,
    });

    const fullMission = await this.prisma.intervention.findUnique({
      where: { id: mission.id },
      include: {
        ...this.missionInclude(),
        events: {
          orderBy: { createdAt: 'asc' },
        },
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
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    return this.decorateMissionWithDistance(userId, fullMission);
  }

  private missionInclude() {
    return {
      client: {
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
        },
      },
      artisan: {
        select: {
          id: true,
          name: true,
          phone: true,
          latitude: true,
          longitude: true,
        },
      },
      subService: true,
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
      review: true,
    };
  }

  // ==========================================================
  // 6. MISSION ACTIONS
  // ==========================================================

  async acceptMission(userId: number, interventionId: number) {
    await this.ensureApprovedArtisan(userId);

    const intervention = await this.getMissionForArtisan(
      userId,
      interventionId,
      {
        allowUnassigned: true,
      },
    );

    if (!this.canAcceptMissionStatus(intervention.status)) {
      throw new BadRequestException(
        'Cette mission ne peut pas être acceptée.',
      );
    }

    const updated = await this.prisma.intervention.update({
      where: { id: intervention.id },
      data: {
        artisanId: userId,
        status: Status.ACCEPTED,
        artisanAcceptedAt: new Date(),
        lastStatusChangedAt: new Date(),
      },
      include: this.missionInclude(),
    });

    await this.createMissionEvent({
      interventionId: intervention.id,
      type: InterventionEventType.ARTISAN_ACCEPTED,
      title: 'Mission acceptée',
      message: 'L’artisan a accepté la mission.',
      createdById: userId,
    });

    if (updated.client?.phone) {
      await this.notifications.sendSms(
        updated.client.phone,
        `Smart Dépannage: votre mission a été acceptée par ${updated.artisan?.name || 'un artisan'}.`,
      );
    }

    return updated;
  }

  async rejectMission(
    userId: number,
    interventionId: number,
    dto: RejectMissionDto,
  ) {
    const profile = await this.ensureApprovedArtisan(userId);

    const intervention = await this.getMissionForArtisan(
      userId,
      interventionId,
      {
        allowUnassigned: true,
      },
    );

    await this.prisma.$transaction([
      this.prisma.artisanMissionRejection.create({
        data: {
          artisanProfileId: profile.id,
          interventionId: intervention.id,
          reason: dto.reason,
          note: dto.note,
        },
      }),

      this.prisma.intervention.update({
        where: { id: intervention.id },
        data: {
          artisanRejectedAt: new Date(),
          artisanId:
            intervention.artisanId === userId ? null : intervention.artisanId,
          status:
            intervention.artisanId === userId
              ? Status.ADMIN_REVIEW
              : intervention.status,
          lastStatusChangedAt: new Date(),
        },
      }),
    ]);

    await this.createMissionEvent({
      interventionId: intervention.id,
      type: InterventionEventType.CANCELLED,
      title: 'Mission refusée par artisan',
      message: dto.note || `Motif: ${dto.reason}`,
      createdById: userId,
    });

    return {
      message: 'Mission refusée.',
    };
  }

  async markOnTheWay(userId: number, interventionId: number) {
    await this.ensureApprovedArtisan(userId);
    await this.getMissionForArtisan(userId, interventionId);

    const updated = await this.prisma.intervention.update({
      where: { id: interventionId },
      data: {
        status: Status.ON_THE_WAY,
        artisanOnTheWayAt: new Date(),
        lastStatusChangedAt: new Date(),
      },
      include: this.missionInclude(),
    });

    await this.createMissionEvent({
      interventionId,
      type: InterventionEventType.ARTISAN_ON_THE_WAY,
      title: 'Artisan en route',
      message: 'L’artisan est en route vers l’adresse.',
      createdById: userId,
    });

    if (updated.client?.phone) {
      await this.notifications.sendSms(
        updated.client.phone,
        'Smart Dépannage: votre artisan est en route.',
      );
    }

    return updated;
  }

  async markArrived(userId: number, interventionId: number) {
    await this.ensureApprovedArtisan(userId);
    await this.getMissionForArtisan(userId, interventionId);

    const updated = await this.prisma.intervention.update({
      where: { id: interventionId },
      data: {
        status: Status.ARRIVED,
        artisanArrivedAt: new Date(),
        lastStatusChangedAt: new Date(),
      },
      include: this.missionInclude(),
    });

    await this.createMissionEvent({
      interventionId,
      type: InterventionEventType.ARTISAN_ARRIVED,
      title: 'Artisan arrivé',
      message: 'L’artisan est arrivé sur place.',
      createdById: userId,
    });

    return updated;
  }

  async startIntervention(userId: number, interventionId: number) {
    await this.ensureApprovedArtisan(userId);
    await this.getMissionForArtisan(userId, interventionId);

    const updated = await this.prisma.intervention.update({
      where: { id: interventionId },
      data: {
        status: Status.IN_PROGRESS,
        workStartedAt: new Date(),
        lastStatusChangedAt: new Date(),
      },
      include: this.missionInclude(),
    });

    await this.createMissionEvent({
      interventionId,
      type: InterventionEventType.WORK_STARTED,
      title: 'Travaux commencés',
      message: 'L’intervention a commencé.',
      createdById: userId,
    });

    return updated;
  }

  async uploadBeforePhoto(
    userId: number,
    interventionId: number,
    dto: UploadProofPhotoDto,
  ) {
    await this.ensureApprovedArtisan(userId);
    await this.getMissionForArtisan(userId, interventionId);

    const updated = await this.prisma.intervention.update({
      where: { id: interventionId },
      data: {
        beforePhotoUrl: dto.photoUrl,
        beforePhotoLat: dto.latitude,
        beforePhotoLng: dto.longitude,
        beforePhotoAt: dto.timestamp ? new Date(dto.timestamp) : new Date(),
      },
      include: this.missionInclude(),
    });

    await this.createMissionEvent({
      interventionId,
      type: InterventionEventType.WORK_STARTED,
      title: 'Photo avant intervention ajoutée',
      message: 'Une preuve photo avant intervention a été enregistrée.',
      createdById: userId,
    });

    return updated;
  }

  async addDiagnostic(
    userId: number,
    interventionId: number,
    dto: AddDiagnosticDto,
  ) {
    await this.ensureApprovedArtisan(userId);
    await this.getMissionForArtisan(userId, interventionId);

    return this.prisma.intervention.update({
      where: { id: interventionId },
      data: {
        diagnosticNotes: dto.diagnosticNotes,
      },
      include: this.missionInclude(),
    });
  }

  async addMaterialUsed(
    userId: number,
    interventionId: number,
    dto: AddMaterialUsedDto,
  ) {
    await this.ensureApprovedArtisan(userId);
    await this.getMissionForArtisan(userId, interventionId);

    return this.prisma.intervention.update({
      where: { id: interventionId },
      data: {
        materialUsed: dto.items as any,
      },
      include: this.missionInclude(),
    });
  }

  async requestExtraQuote(
    userId: number,
    interventionId: number,
    dto: RequestExtraQuoteDto,
  ) {
    await this.ensureApprovedArtisan(userId);
    await this.getMissionForArtisan(userId, interventionId);

    const updated = await this.prisma.intervention.update({
      where: { id: interventionId },
      data: {
        extraQuoteRequested: true,
        extraQuoteReason: dto.reason,
      },
      include: this.missionInclude(),
    });

    await this.createMissionEvent({
      interventionId,
      type: InterventionEventType.QUOTE_MODIFICATION_REQUESTED,
      title: 'Devis complémentaire demandé',
      message: dto.reason,
      createdById: userId,
    });

    return updated;
  }

  async uploadAfterPhoto(
    userId: number,
    interventionId: number,
    dto: UploadProofPhotoDto,
  ) {
    await this.ensureApprovedArtisan(userId);
    await this.getMissionForArtisan(userId, interventionId);

    const updated = await this.prisma.intervention.update({
      where: { id: interventionId },
      data: {
        afterPhotoUrl: dto.photoUrl,
        afterPhotoLat: dto.latitude,
        afterPhotoLng: dto.longitude,
        afterPhotoAt: dto.timestamp ? new Date(dto.timestamp) : new Date(),
      },
      include: this.missionInclude(),
    });

    await this.createMissionEvent({
      interventionId,
      type: InterventionEventType.WORK_COMPLETED,
      title: 'Photo après intervention ajoutée',
      message: 'Une preuve photo après intervention a été enregistrée.',
      createdById: userId,
    });

    return updated;
  }

  async collectClientSignature(
    userId: number,
    interventionId: number,
    dto: CollectSignatureDto,
  ) {
    await this.ensureApprovedArtisan(userId);
    await this.getMissionForArtisan(userId, interventionId);

    const updated = await this.prisma.intervention.update({
      where: { id: interventionId },
      data: {
        clientSignatureUrl: dto.signatureUrl,
        clientSignatureAt: new Date(),
      },
      include: this.missionInclude(),
    });

    await this.createMissionEvent({
      interventionId,
      type: InterventionEventType.WORK_COMPLETED,
      title: 'Signature client collectée',
      message: dto.signedByName
        ? `Signature collectée auprès de ${dto.signedByName}.`
        : 'Signature client collectée.',
      createdById: userId,
    });

    return updated;
  }

  async completeIntervention(userId: number, interventionId: number) {
    const profile = await this.ensureApprovedArtisan(userId);
    const intervention = await this.getMissionForArtisan(userId, interventionId);

    if (!intervention.afterPhotoUrl) {
      throw new BadRequestException(
        'Ajoutez une photo après intervention avant de terminer.',
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const completed = await tx.intervention.update({
        where: { id: interventionId },
        data: {
          status: Status.COMPLETED,
          workCompletedAt: new Date(),
          lastStatusChangedAt: new Date(),
        },
        include: this.missionInclude(),
      });

      await tx.artisanProfile.update({
        where: { id: profile.id },
        data: {
          completedJobsCount: {
            increment: 1,
          },
          availabilityStatus: ArtisanAvailabilityStatus.ONLINE,
        },
      });

      return completed;
    });

    await this.createMissionEvent({
      interventionId,
      type: InterventionEventType.WORK_COMPLETED,
      title: 'Intervention terminée',
      message: 'L’intervention a été marquée comme terminée.',
      createdById: userId,
    });

    if (updated.client?.phone) {
      await this.notifications.sendSms(
        updated.client.phone,
        'Smart Dépannage: votre intervention est terminée.',
      );
    }

    return updated;
  }

  async reportProblem(
    userId: number,
    interventionId: number,
    dto: ReportProblemDto,
  ) {
    await this.ensureApprovedArtisan(userId);
    await this.getMissionForArtisan(userId, interventionId);

    const updated = await this.prisma.intervention.update({
      where: { id: interventionId },
      data: {
        problemReported: true,
        problemType: dto.problemType,
        problemNotes: dto.notes,
        hasIssue: true,
        status: Status.DISPUTED,
        lastStatusChangedAt: new Date(),
      },
      include: this.missionInclude(),
    });

    await this.createMissionEvent({
      interventionId,
      type: InterventionEventType.ISSUE_REPORTED,
      title: 'Problème signalé par artisan',
      message: dto.notes || `Type: ${dto.problemType}`,
      createdById: userId,
    });

    return updated;
  }

  // ==========================================================
  // 7. CONTACT CLIENT / ADMIN
  // ==========================================================

  async contactClient(
    userId: number,
    interventionId: number,
    dto: ContactMessageDto,
  ) {
    await this.ensureApprovedArtisan(userId);
    await this.getMissionForArtisan(userId, interventionId);

    return this.prisma.message.create({
      data: {
        interventionId,
        senderId: userId,
        audience: MessageAudience.CLIENT_ARTISAN,
        content: dto.content,
        attachments: dto.attachments || [],
      },
      include: {
        sender: {
          select: {
            id: true,
            name: true,
            role: true,
          },
        },
      },
    });
  }

  async contactAdmin(
    userId: number,
    interventionId: number,
    dto: ContactMessageDto,
  ) {
    await this.ensureApprovedArtisan(userId);
    await this.getMissionForArtisan(userId, interventionId);

    return this.prisma.message.create({
      data: {
        interventionId,
        senderId: userId,
        audience: MessageAudience.ARTISAN_SUPPORT,
        content: dto.content,
        attachments: dto.attachments || [],
      },
      include: {
        sender: {
          select: {
            id: true,
            name: true,
            role: true,
          },
        },
      },
    });
  }

  // ==========================================================
  // 8. ADMIN ARTISAN MANAGEMENT
  // ==========================================================

  async adminFindAll(params?: {
    status?: ArtisanVerificationStatus;
    search?: string;
    page?: number;
    limit?: number;
  }) {
    const page = params?.page || 1;
    const limit = params?.limit || 20;
    const skip = (page - 1) * limit;

    const where: Prisma.ArtisanProfileWhereInput = {};

    if (params?.status) {
      where.verificationStatus = params.status;
    }

    if (params?.search) {
      where.OR = [
        {
          user: {
            email: {
              contains: params.search,
              mode: 'insensitive',
            },
          },
        },
        {
          user: {
            name: {
              contains: params.search,
              mode: 'insensitive',
            },
          },
        },
        {
          companyName: {
            contains: params.search,
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
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
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

  async adminFindOne(profileId: number) {
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

    return profile;
  }

  async approveArtisan(
    adminId: number,
    profileId: number,
    dto: AdminReviewArtisanDto,
  ) {
    const profile = await this.adminFindOne(profileId);

    const updated = await this.prisma.$transaction(async (tx) => {
      const updatedProfile = await tx.artisanProfile.update({
        where: { id: profileId },
        data: {
          verificationStatus: ArtisanVerificationStatus.APPROVED,
          verifiedAt: new Date(),
          verifiedById: adminId,
          rejectionReason: null,
        },
        include: {
          user: true,
        },
      });

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

      return updatedProfile;
    });

    await this.sendPasswordSetupEmail(profile.userId);

    return {
      message:
        dto.note ||
        'Artisan approuvé. Un email de création de mot de passe a été envoyé.',
      profile: updated,
    };
  }

  async rejectArtisan(
    adminId: number,
    profileId: number,
    dto: AdminReviewArtisanDto,
  ) {
    const profile = await this.adminFindOne(profileId);

    const updated = await this.prisma.$transaction(async (tx) => {
      const updatedProfile = await tx.artisanProfile.update({
        where: { id: profileId },
        data: {
          verificationStatus: ArtisanVerificationStatus.REJECTED,
          rejectionReason: dto.note || 'Candidature refusée.',
        },
      });

      await tx.user.update({
        where: { id: profile.userId },
        data: {
          isActive: false,
        },
      });

      return updatedProfile;
    });

    if (profile.user.email) {
      await this.notifications.sendEmail(
        profile.user.email,
        'Candidature artisan refusée',
        dto.note || 'Votre candidature artisan a été refusée.',
      );
    }

    return updated;
  }

  async suspendArtisan(
    adminId: number,
    profileId: number,
    dto: AdminReviewArtisanDto,
  ) {
    const profile = await this.adminFindOne(profileId);

    const updated = await this.prisma.$transaction(async (tx) => {
      const updatedProfile = await tx.artisanProfile.update({
        where: { id: profileId },
        data: {
          verificationStatus: ArtisanVerificationStatus.SUSPENDED,
          rejectionReason: dto.note || 'Profil suspendu.',
        },
      });

      await tx.user.update({
        where: { id: profile.userId },
        data: {
          isActive: false,
        },
      });

      return updatedProfile;
    });

    return updated;
  }
}