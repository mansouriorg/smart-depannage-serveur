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
import { MissionActionsService } from '../mission-actions/mission-actions.service';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { FilesService, ApplicantDocumentKind, StoredLocalFile } from '../files/files.service';
import { ArtisanZoneRow, artisanZoneRowsFor } from '../service-zones/zone-pick';
import { ACTIVE_APPOINTMENT_STATUSES } from '../assignment/artisan-availability';
import { forMarketplace, withoutStaffFields } from '../interventions/intervention-redaction';
import { chatsOf, messageForParties } from '../../common/views/views';
import { INVOICES_OF_JOB } from '../invoices/invoice-includes';
import { withAliases } from '../intervention-workflow/intervention-status';
import { ARTISAN_DONE_STATUSES } from './artisan-done';
import { isOpenJob } from '../mission-actions/open-job';
import {
  transitionStatus,
  transitionStatusDetailed,
} from '../intervention-workflow/transition-status';

import { ApplyArtisanDto } from './dto/apply-artisan.dto';
import { UpdateArtisanProfileDto } from './dto/update-artisan-profile.dto';
import { UploadArtisanDocumentDto } from './dto/upload-artisan-document.dto';
import { CreateServiceZoneDto } from './dto/create-service-zone.dto';
import { UpdateAvailabilityDto } from './dto/update-availability.dto';
import { slotOrderProblem } from './dto/slot-time';
import { UpdateBankDetailsDto } from './dto/update-bank-details.dto';
import { UpdateArtisanLocationDto } from './dto/update-artisan-location.dto';
import { RejectMissionDto } from './dto/reject-mission.dto';
import { AddDiagnosticDto } from './dto/add-diagnostic.dto';
import { AddMaterialUsedDto } from './dto/add-material-used.dto';
import { RequestExtraQuoteDto } from './dto/request-extra-quote.dto';
import { CollectSignatureDto } from './dto/collect-signature.dto';
import { ReportProblemDto } from './dto/report-problem.dto';
import { ContactMessageDto } from './dto/contact-message.dto';
import { tradeFieldsFor, tradeFieldsForEdit, tradesOfProfile } from './trade-fields';
import type { Locale } from '../../common/i18n/i18n';
import { MESSAGES, localeOfUser, recipientLocale, say } from '../../common/i18n/messages';
import { FitJob, misfitOf } from './job-fit';
import { drawableZones } from '../../common/geo/zone-match';

import {
  ArtisanAvailabilityStatus,
  ArtisanDocumentStatus,
  ArtisanDocumentType,
  ArtisanVerificationStatus,
  InterventionEventType,
  MessageAudience,
  Prisma,
  Role,
  ServiceType,
  Status,
} from '../../../generated/prisma/client';
import {
  PhoneColumns,
  phoneColumns,
  phoneWhere,
  rethrowContactConflict,
} from '../../common/contact/phone';

/** The files of an application, by what they are (the controller names them from the form fields). */
export type ApplicantDocuments = Partial<Record<ApplicantDocumentKind, Express.Multer.File>>;

const APPLICANT_DOCUMENT_KINDS: ApplicantDocumentKind[] = ['identity', 'company', 'insurance'];

@Injectable()
export class ArtisansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly events: InterventionEventsService,
    private readonly rateLimit: RateLimitService,
    private readonly missionActions: MissionActionsService,
    private readonly files: FilesService,
  ) {}

  // ==========================================================
  // 1. HELPERS
  // ==========================================================

  private generateTemporaryPassword(): string {
    return `Artisan-Unusable-${crypto.randomBytes(64).toString('hex')}`;
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private normalizePhone(phone?: string): string | undefined {
    return phone?.trim() || undefined;
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
    // Open: nobody has it, or it waits in the queue (an id left on it by the back office does not count).
    const isOpen = isOpenJob(intervention);

    if (!isAssignedToArtisan) {
      if (!(options?.allowUnassigned && isOpen)) {
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

    return withoutStaffFields({
      ...mission,
      distanceKm,
      etaMinutes: this.estimateEtaMinutes(distanceKm),
      navigationUrl: this.navigationUrl(mission),
    });
  }

  // ==========================================================
  // 2. ARTISAN ONBOARDING
  // ==========================================================

  async apply(
    dto: ApplyArtisanDto,
    documents: ApplicantDocuments = {},
    /** `declaredLocale(request)`: the language the form was shown in, or null when the request does not say (P3-04). */
    language: Locale | null = null,
  ) {
    // A name that is no trade is refused before anything is created (P1-10).
    const trades = tradeFieldsFor({ specialty: dto.specialty, specialties: dto.specialties })!;

    // The documents are looked at before anything is stored or created (P1-11): the identity
    // document is required, the others are optional, and each is checked by its first bytes.
    for (const kind of APPLICANT_DOCUMENT_KINDS) {
      if (kind === 'identity' || documents[kind]) this.files.assertApplicantDocument(documents[kind], kind);
    }

    // The zones come from the platform's list, with a centre and a radius; one at least.
    const zones = await artisanZoneRowsFor(this.prisma, dto.zoneIds ?? []);

    if (!zones.length) {
      throw new BadRequestException('Choisissez au moins une zone d’intervention.');
    }

    const email = this.normalizeEmail(dto.email);
    const phone = this.normalizePhone(dto.phone);

    // A number that cannot be one is refused before any file is decoded or kept.
    const phoneCols = phoneColumns(phone);

    const existingUser = await this.prisma.user.findFirst({
      where: {
        OR: [{ email }, phoneWhere(phone)].filter(Boolean) as any[],
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

    const result = await this.storeApplication({
      dto,
      trades,
      zones,
      email,
      phoneCols,
      hashedPassword,
      existingUser,
      documents,
      language,
    });

    // The back office is told there is something in its queue; a failure here never undoes the application.
    await this.notifications
      .notifyArtisanApplication({ profileId: result.id, name: dto.name, trades: trades.specialties })
      .catch(() => undefined);

    // The applicant is written to in the language the form was shown in; an account that already exists keeps the one it has.
    const locale = language ?? recipientLocale(existingUser);

    // Public form: the destination is whatever the visitor typed, so each one
    // gets a few messages per hour at most.
    if (this.rateLimit.allowSendTo('email', email)) {
      await this.notifications.sendEmail(
        email,
        say(MESSAGES.application.received.subject, locale),
        say(MESSAGES.application.received.body, locale),
      );
    }

    if (phone && this.rateLimit.allowSendTo('sms', phone)) {
      await this.notifications.sendSms(
        phone,
        say(MESSAGES.application.received.sms, locale),
      );
    }

    return {
      message: 'Candidature artisan envoyée avec succès.',
      profile: result,
    };
  }

  /**
   * The files are written first, then the account, the profile, the zones and the documents in one
   * transaction. If anything fails the files are taken away again, so a refused application leaves
   * neither an account nor a file.
   */
  private async storeApplication(params: {
    dto: ApplyArtisanDto;
    trades: NonNullable<ReturnType<typeof tradeFieldsFor>>;
    zones: ArtisanZoneRow[];
    email: string;
    phoneCols: PhoneColumns;
    hashedPassword: string;
    existingUser: { id: number; role: Role } | null;
    documents: ApplicantDocuments;
    language: Locale | null;
  }) {
    const { dto, trades, zones, email, phoneCols, hashedPassword, existingUser, documents, language } = params;
    const staged: Array<{ kind: ApplicantDocumentKind; file: Express.Multer.File; stored: StoredLocalFile }> = [];

    try {
      for (const kind of APPLICANT_DOCUMENT_KINDS) {
        const file = documents[kind];

        if (file) staged.push({ kind, file, stored: await this.files.stageApplicantDocument(file, kind) });
      }

      return await this.prisma.$transaction(async (tx) => {
        const user =
          existingUser ||
          (await tx.user
            .create({
              data: {
                email,
                ...phoneCols,
                name: dto.name,
                password: hashedPassword,
                role: Role.ARTISAN,
                isActive: false,
                ...(language ? { locale: language } : {}),
              },
            })
            .catch(rethrowContactConflict));

        const profile = await tx.artisanProfile.create({
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
            verificationStatus: ArtisanVerificationStatus.PENDING_REVIEW,
          },
          include: {
            user: {
              select: this.safeUserSelect,
            },
          },
        });

        await tx.artisanServiceZone.createMany({
          data: zones.map((zone) => ({ ...zone, artisanProfileId: profile.id })),
        });

        for (const { kind, file, stored } of staged) {
          await this.files.recordApplicantDocument(tx, { id: user.id, role: user.role }, file, stored, kind, profile.id);
        }

        return profile;
      });
    } catch (error) {
      await Promise.all(staged.map((item) => this.files.discardStagedPhoto(item.stored)));

      throw error;
    }
  }

  // ==========================================================
  // 3. ARTISAN PROFILE
  // ==========================================================

  async getMyProfile(userId: number) {
    const profile = await this.getArtisanProfileByUserId(userId);

    // The jobs this artisan really did. The stored counter is only moved by the old manual "complete"
    // route, not by the photo proof, so it would say 0 for a job done the new way (P1-15). A job whose work
    // is done but that is waiting for the customer's validation or payment is done for the artisan: these
    // are the statuses of the "Terminées" pile of the phone app (mission-flow.ts of the shared package).
    const completedMissions = await this.prisma.intervention.count({
      where: { artisanId: userId, status: { in: withAliases(ARTISAN_DONE_STATUSES) as Status[] } },
    });

    return { ...profile, completedMissions };
  }

  async updateMyProfile(userId: number, dto: UpdateArtisanProfileDto) {
    const profile = await this.getArtisanProfileByUserId(userId);

    // Trades are written together (the main one, the list, the service types); null = not sent (P1-10).
    const trades = tradeFieldsForEdit({ specialty: dto.specialty, specialties: dto.specialties }, profile);

    return this.prisma.artisanProfile.update({
      where: { id: profile.id },
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

    // A zone of the platform's list: its centre and radius are copied (P1-11).
    if (dto.zoneId !== undefined) {
      const [row] = await artisanZoneRowsFor(this.prisma, [dto.zoneId]);

      const already = (profile.serviceZones ?? []).some((zone: any) => zone.adminZoneId === row.adminZoneId);

      if (already) {
        throw new BadRequestException(`Vous travaillez déjà dans la zone « ${row.label} ».`);
      }

      return this.prisma.artisanServiceZone.create({
        data: { ...row, artisanProfileId: profile.id },
      });
    }

    // A circle of their own needs a centre: a name alone cannot be checked against a job.
    if (typeof dto.latitude !== 'number' || typeof dto.longitude !== 'number') {
      throw new BadRequestException(
        'Choisissez une zone de la liste, ou indiquez le centre de votre zone (latitude et longitude).',
      );
    }

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

    // An artisan with no zone that can be drawn sees every job of their trades (zoneVerdict), so
    // taking away the last one would be a way out of the zones they were approved for.
    const others = (profile.serviceZones ?? []).filter((candidate: { id: number }) => candidate.id !== zone.id);

    if (drawableZones([zone]).length && !drawableZones(others).length) {
      throw new BadRequestException(
        'Gardez au moins une zone d’intervention : ajoutez-en une autre avant de supprimer celle-ci.',
      );
    }

    await this.prisma.artisanServiceZone.delete({
      where: { id: zoneId },
    });

    return {
      message: 'Zone supprimée avec succès.',
    };
  }

  async updateAvailability(userId: number, dto: UpdateAvailabilityDto) {
    const problem = dto.slots ? slotOrderProblem(dto.slots) : null;

    if (problem) throw new BadRequestException(problem);

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
          // A position is not a decision to work: an artisan who went offline stays offline when
          // the phone reports where it is (P1-15). Online and offline have their own routes. What is not
          // sent is not written, so a status changed a moment ago (by the dispatcher, by a job that began)
          // is not put back to the value read a moment before.
          availabilityStatus: dto.availabilityStatus,
          isAcceptingJobs: dto.isAcceptingJobs,
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

    // The jobs of the artisan's trades. The words of the profile used to be handed to the database
    // as if they were service types, so "Plombier" made the board fail (P1-10).
    const trades = tradesOfProfile(profile);

    const availableWhere: Prisma.InterventionWhereInput = {
      artisanId: null,
      status: {
        in: withAliases([
          'CREATED',
          'WAITING_ADMIN_REVIEW',
          'QUOTE_ACCEPTED',
        ]) as Status[],
      },
      // A mission this artisan refused (or gave back) is not offered to them again (P1-06).
      missionRejections: { none: { artisanProfileId: profile.id } },
    };

    if (trades) {
      availableWhere.serviceType = {
        in: trades as ServiceType[],
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
          status: { in: withAliases(['ARTISAN_ACCEPTED']) as Status[] },
        },
        include: this.missionInclude(),
        orderBy: { createdAt: 'desc' },
      }),

      this.prisma.intervention.findMany({
        where: {
          artisanId: userId,
          status: {
            in: withAliases([
              'ARTISAN_ON_THE_WAY',
              'ARTISAN_ARRIVED',
              'IN_PROGRESS',
              'WAITING_CLIENT_VALIDATION',
            ]) as Status[],
          },
        },
        include: this.missionInclude(),
        orderBy: { createdAt: 'desc' },
      }),

      this.prisma.intervention.findMany({
        where: {
          artisanId: userId,
          status: {
            in: withAliases([
              'COMPLETED',
              'PAYMENT_PENDING',
              'PAID',
              'INVOICE_SENT',
            ]) as Status[],
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

    // A job with a visit already fixed goes through the dispatcher (taking it is refused with a
    // 409), so it is not offered here.
    const takable = await this.withoutFixedVisit(availableJobs);

    // The trades are asked of the database above; the zones are circles, judged here with the same
    // rule as the matching and as the taking of a job (P1-11).
    const inReach = takable.filter((job) => !misfitOf(profile, job as FitJob));

    return {
      availableJobs: await Promise.all(
        inReach.map((job) =>
          this.decorateMissionWithDistance(userId, this.asOpenMission(job)),
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
      completedJobs: completedJobs.map((job) => withoutStaffFields(job)),
      cancelledJobs: cancelledJobs.map((job) => withoutStaffFields(job)),
    };
  }

  /** The jobs that have no visit still to come (a fixed time is for the dispatcher to give). */
  private async withoutFixedVisit<T extends { id: number }>(jobs: T[]): Promise<T[]> {
    if (!jobs.length) return jobs;

    const fixed = await this.prisma.appointment.findMany({
      where: {
        interventionId: { in: jobs.map((job) => job.id) },
        status: { in: ACTIVE_APPOINTMENT_STATUSES },
        startsAt: { not: null },
        endsAt: { gt: new Date() },
      },
      select: { interventionId: true },
    });

    const taken = new Set(fixed.map((visit) => visit.interventionId));

    return jobs.filter((job) => !taken.has(job.id));
  }

  async getMissionDetails(userId: number, interventionId: number) {
    const profile = await this.ensureApprovedArtisan(userId);

    const mission = await this.getMissionForArtisan(userId, interventionId, {
      allowUnassigned: true,
    });

    // Nobody has it, or it waits in the queue (those are the only other cases getMissionForArtisan
    // lets through; a job of this artisan that is back in the queue is open for them too).
    const open = isOpenJob(mission);

    if (open) {
      // An artisan who refused or gave back a mission is not shown it again, with the client's
      // phone and the messages of the job that go with it.
      const refused = await this.prisma.artisanMissionRejection.findFirst({
        where: { artisanProfileId: profile.id, interventionId: mission.id },
        select: { id: true },
      });

      if (refused) {
        throw new ForbiddenException('Cette mission ne vous est pas attribuée.');
      }

      // Nor one the board does not list for them (another trade, or outside their zones): the
      // client's phone and the messages that go with it are not for them either (P1-11).
      if (misfitOf(profile, mission)) {
        throw new ForbiddenException('Cette mission ne vous est pas attribuée.');
      }
    }

    const fullMission = await this.prisma.intervention.findUnique({
      where: { id: mission.id },
      include: {
        ...this.missionInclude(),
        // The conversation and the timeline of a job belong to the people on it, not to
        // whoever looks at the board.
        ...(open
          ? {}
          : {
              events: {
                orderBy: { createdAt: 'asc' },
              },
              // The artisan's two chats only (with the customer, with the support): not the
              // customer's chat with the support, nor a message that was deleted.
              messages: {
                where: { deletedAt: null, audience: { in: chatsOf('artisan') as any[] } },
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
            }),
      },
    });

    // The same shape for an open mission: the lists are there, and empty.
    return this.decorateMissionWithDistance(
      userId,
      open ? this.asOpenMission({ ...fullMission, events: [], messages: [] }) : fullMission,
    );
  }

  /**
   * An open mission, as every artisan may see it: what the job is and where, never the way to
   * reach the client (the same rule as the open jobs of the older list), nor the payments of the
   * job. The distance and the navigation link need the address, so they stay.
   */
  private asOpenMission(job: any) {
    return forMarketplace({
      ...job,
      client: job.client ? { name: job.client.name } : job.client,
      payments: [],
      invoice: null,
    });
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
      invoices: INVOICES_OF_JOB,
      review: true,
    };
  }

  // ==========================================================
  // 6. MISSION ACTIONS
  // ==========================================================

  // Accept, give back, on the way, arrived: one service (P1-06). It checks that the artisan
  // is approved and that the mission is theirs (or open), changes the status once through the
  // status table, and tells the client and the back office.

  acceptMission(userId: number, interventionId: number) {
    return this.missionActions.accept({ userId, interventionId, include: this.missionInclude() });
  }

  rejectMission(
    userId: number,
    interventionId: number,
    dto: RejectMissionDto,
  ) {
    return this.missionActions.decline({
      userId,
      interventionId,
      reason: dto.reason,
      note: dto.note,
    });
  }

  markOnTheWay(userId: number, interventionId: number) {
    return this.missionActions.onTheWay({ userId, interventionId, include: this.missionInclude() });
  }

  markArrived(userId: number, interventionId: number) {
    return this.missionActions.arrived({ userId, interventionId, include: this.missionInclude() });
  }

  async startIntervention(userId: number, interventionId: number) {
    await this.ensureApprovedArtisan(userId);
    await this.getMissionForArtisan(userId, interventionId);

    const { row: updated, changed } = await transitionStatusDetailed(
      this.prisma,
      {
        id: interventionId,
        to: Status.IN_PROGRESS,
        actor: { kind: 'artisan', userId },
        dataOnChange: { workStartedAt: new Date() },
        include: this.missionInclude(),
      },
    );

    if (!changed) return withoutStaffFields(updated);

    await this.createMissionEvent({
      interventionId,
      type: InterventionEventType.WORK_STARTED,
      title: 'Travaux commencés',
      message: 'L’intervention a commencé.',
      createdById: userId,
    });

    return withoutStaffFields(updated);
  }

  async addDiagnostic(
    userId: number,
    interventionId: number,
    dto: AddDiagnosticDto,
  ) {
    await this.ensureApprovedArtisan(userId);
    await this.getMissionForArtisan(userId, interventionId);

    return withoutStaffFields(
      await this.prisma.intervention.update({
        where: { id: interventionId },
        data: {
          diagnosticNotes: dto.diagnosticNotes,
        },
        include: this.missionInclude(),
      }),
    );
  }

  async addMaterialUsed(
    userId: number,
    interventionId: number,
    dto: AddMaterialUsedDto,
  ) {
    await this.ensureApprovedArtisan(userId);
    await this.getMissionForArtisan(userId, interventionId);

    return withoutStaffFields(
      await this.prisma.intervention.update({
        where: { id: interventionId },
        data: {
          materialUsed: dto.items as any,
        },
        include: this.missionInclude(),
      }),
    );
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

    return withoutStaffFields(updated);
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

    return withoutStaffFields(updated);
  }

  async completeIntervention(userId: number, interventionId: number) {
    const profile = await this.ensureApprovedArtisan(userId);
    const intervention = await this.getMissionForArtisan(userId, interventionId);

    if (!intervention.afterPhotoUrl) {
      throw new BadRequestException(
        'Ajoutez une photo après intervention avant de terminer.',
      );
    }

    const { row: updated, changed } = await this.prisma.$transaction(
      async (tx) => {
        const result = await transitionStatusDetailed(tx, {
          id: interventionId,
          to: Status.COMPLETED,
          actor: { kind: 'artisan', userId },
          dataOnChange: { workCompletedAt: new Date() },
          include: this.missionInclude(),
        });

        // Counted once: a second call on a finished job changes nothing.
        if (result.changed) {
          await tx.artisanProfile.update({
            where: { id: profile.id },
            data: {
              completedJobsCount: {
                increment: 1,
              },
              availabilityStatus: ArtisanAvailabilityStatus.ONLINE,
            },
          });
        }

        return result;
      },
    );

    if (!changed) return withoutStaffFields(updated);

    await this.createMissionEvent({
      interventionId,
      type: InterventionEventType.WORK_COMPLETED,
      title: 'Intervention terminée',
      message: 'L’intervention a été marquée comme terminée.',
      createdById: userId,
    });

    if (updated.client?.phone) {
      const locale = await localeOfUser(this.prisma, updated.clientId ?? updated.client?.id);

      await this.notifications.sendSms(
        updated.client.phone,
        say(MESSAGES.mission.completed.sms, locale),
      );
    }

    return withoutStaffFields(updated);
  }

  async reportProblem(
    userId: number,
    interventionId: number,
    dto: ReportProblemDto,
  ) {
    await this.ensureApprovedArtisan(userId);
    await this.getMissionForArtisan(userId, interventionId);

    const updated = await transitionStatus(this.prisma, {
      id: interventionId,
      to: Status.DISPUTED,
      actor: { kind: 'artisan', userId },
      data: {
        problemReported: true,
        problemType: dto.problemType,
        problemNotes: dto.notes,
        hasIssue: true,
      },
      include: this.missionInclude(),
    });

    await this.createMissionEvent({
      interventionId,
      type: InterventionEventType.ISSUE_REPORTED,
      title: 'Problème signalé par artisan',
      message: dto.notes || `Type: ${dto.problemType}`,
      createdById: userId,
      // What the artisan tells the back office is not for the customer's timeline (P1-08).
      metadata: { internal: true },
    });

    return withoutStaffFields(updated);
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

    const message = await this.prisma.message.create({
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

    return messageForParties(message, userId);
  }

  async contactAdmin(
    userId: number,
    interventionId: number,
    dto: ContactMessageDto,
  ) {
    await this.ensureApprovedArtisan(userId);
    await this.getMissionForArtisan(userId, interventionId);

    const message = await this.prisma.message.create({
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

    return messageForParties(message, userId);
  }
}
