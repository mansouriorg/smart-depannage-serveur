import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';

import {
  AppointmentStatus,
  ArtisanAvailabilityStatus,
  ArtisanVerificationStatus,
  Role,
  ServiceType,
  Status,
} from '../../../generated/prisma/client';

import {
  AssignMatchedArtisanDto,
  MatchArtisansQueryDto,
} from './dto/matching.dto';

type MatchingRange = {
  startsAt?: Date;
  endsAt?: Date;
};

type MatchingContext = {
  serviceType: ServiceType;
  specialty?: string;
  latitude?: number;
  longitude?: number;
  startsAt?: Date;
  endsAt?: Date;
  emergency?: boolean;
  limit?: number;
  onlyAvailable?: boolean;
};

@Injectable()
export class MatchingService {
  constructor(
    private readonly prisma: PrismaService,

    @Optional()
    private readonly realtime?: RealtimeService,
  ) {}

  // ==========================================================
  // Helpers
  // ==========================================================

  private isStaff(role: Role): boolean {
    return [
      Role.ADMIN,
      Role.SUPER_ADMIN,
      Role.SUPPORT,
      Role.DISPATCHER,
      Role.ACCOUNTANT,
    ].includes(role);
  }

  private assertStaff(role: Role) {
    if (!this.isStaff(role)) {
      throw new ForbiddenException('Accès réservé à l’administration.');
    }
  }

  private activeInterventionStatuses(): Status[] {
    return [
      Status.CREATED,
      Status.WAITING_ADMIN_REVIEW,
      Status.QUOTE_SENT,
      Status.QUOTE_ACCEPTED,
      Status.ASSIGNED,
      Status.ARTISAN_ACCEPTED,
      Status.ARTISAN_ON_THE_WAY,
      Status.ARTISAN_ARRIVED,
      Status.IN_PROGRESS,
      Status.WAITING_CLIENT_VALIDATION,
      Status.PAYMENT_PENDING,

      // Old compatibility statuses
      Status.PENDING,
      Status.ADMIN_REVIEW,
      Status.ACCEPTED,
      Status.ON_THE_WAY,
      Status.ARRIVED,
    ];
  }

  private activeAppointmentStatuses(): AppointmentStatus[] {
    return [
      AppointmentStatus.SCHEDULED,
      AppointmentStatus.CONFIRMED,
      AppointmentStatus.RESCHEDULE_REQUESTED,
    ];
  }

  private parseRange(startsAt?: string, endsAt?: string): MatchingRange {
    if (!startsAt && !endsAt) {
      return {};
    }

    if (!startsAt || !endsAt) {
      throw new BadRequestException(
        'startsAt et endsAt doivent être fournis ensemble.',
      );
    }

    const start = new Date(startsAt);
    const end = new Date(endsAt);

    if (
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime()) ||
      start >= end
    ) {
      throw new BadRequestException('Créneau invalide.');
    }

    return {
      startsAt: start,
      endsAt: end,
    };
  }

  private combinePreferredDateAndTime(
    preferredDate?: Date | null,
    preferredStartTime?: string | null,
    preferredEndTime?: string | null,
  ): MatchingRange {
    if (!preferredDate || !preferredStartTime || !preferredEndTime) {
      return {};
    }

    const day = preferredDate.toISOString().slice(0, 10);

    const startsAt = new Date(`${day}T${preferredStartTime}:00.000Z`);
    const endsAt = new Date(`${day}T${preferredEndTime}:00.000Z`);

    if (
      Number.isNaN(startsAt.getTime()) ||
      Number.isNaN(endsAt.getTime()) ||
      startsAt >= endsAt
    ) {
      return {};
    }

    return {
      startsAt,
      endsAt,
    };
  }

  private jsDayToDayOfWeek(date: Date) {
    const day = date.getDay();

    switch (day) {
      case 0:
        return 'SUNDAY';
      case 1:
        return 'MONDAY';
      case 2:
        return 'TUESDAY';
      case 3:
        return 'WEDNESDAY';
      case 4:
        return 'THURSDAY';
      case 5:
        return 'FRIDAY';
      case 6:
      default:
        return 'SATURDAY';
    }
  }

  private timeFromDate(date: Date): string {
    return date.toISOString().slice(11, 16);
  }

  private haversineKm(params: {
    lat1: number;
    lng1: number;
    lat2: number;
    lng2: number;
  }): number {
    const earthRadiusKm = 6371;

    const toRad = (value: number) => (value * Math.PI) / 180;

    const dLat = toRad(params.lat2 - params.lat1);
    const dLng = toRad(params.lng2 - params.lng1);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(params.lat1)) *
        Math.cos(toRad(params.lat2)) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return earthRadiusKm * c;
  }

  private estimateArrivalMinutes(
    distanceKm: number | null,
    emergency: boolean,
    availabilityStatus?: ArtisanAvailabilityStatus,
  ): number | null {
    if (distanceKm === null) {
      return null;
    }

    const speedKmH =
      emergency || availabilityStatus === ArtisanAvailabilityStatus.ONLINE
        ? 35
        : 25;

    const preparationMinutes =
      availabilityStatus === ArtisanAvailabilityStatus.ONLINE ? 10 : 20;

    return Math.ceil((distanceKm / speedKmH) * 60 + preparationMinutes);
  }

  private normalizeText(value?: string | null): string {
    return (value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();
  }

  private serviceTypeKeywords(serviceType: ServiceType): string[] {
    const map: Record<ServiceType, string[]> = {
      [ServiceType.PLOMBIER]: [
        'plombier',
        'plomberie',
        'fuite',
        'canalisation',
        'chauffe eau',
      ],
      [ServiceType.MENUISIER]: [
        'menuisier',
        'menuiserie',
        'bois',
        'porte',
        'fenetre',
      ],
      [ServiceType.SERRURIER]: [
        'serrurier',
        'serrurerie',
        'serrure',
        'cle',
        'porte bloquee',
      ],
      [ServiceType.ELECTRICIEN]: [
        'electricien',
        'electricite',
        'panne electrique',
        'tableau',
        'prise',
      ],
      [ServiceType.AUTRE]: [
        'autre',
        'general',
        'multi service',
        'depannage',
      ],
    };

    return map[serviceType];
  }

  private specialtyMatches(params: {
    serviceType: ServiceType;
    requiredSpecialty?: string;
    artisanServiceTypes: ServiceType[];
    specialty?: string | null;
    specialties?: string[];
  }) {
    const serviceTypes = params.artisanServiceTypes || [];

    if (serviceTypes.includes(params.serviceType)) {
      return {
        matches: true,
        score: 25,
        reason: 'Service type exact.',
      };
    }

    const keywords = this.serviceTypeKeywords(params.serviceType);

    const allSpecialties = [
      params.specialty,
      ...(params.specialties || []),
    ]
      .filter(Boolean)
      .map((item) => this.normalizeText(item));

    const keywordMatch = allSpecialties.some((specialty) =>
      keywords.some((keyword) => specialty.includes(this.normalizeText(keyword))),
    );

    if (keywordMatch) {
      return {
        matches: true,
        score: 18,
        reason: 'Spécialité compatible avec le service demandé.',
      };
    }

    if (params.requiredSpecialty) {
      const required = this.normalizeText(params.requiredSpecialty);

      const requiredMatch = allSpecialties.some((specialty) =>
        specialty.includes(required),
      );

      if (requiredMatch) {
        return {
          matches: true,
          score: 16,
          reason: 'Spécialité spécifique compatible.',
        };
      }
    }

    return {
      matches: false,
      score: 0,
      reason: 'Service ou spécialité non compatible.',
    };
  }

  private distanceScore(distanceKm: number | null) {
    if (distanceKm === null) {
      return {
        score: 8,
        reason: 'Distance non disponible.',
      };
    }

    if (distanceKm <= 3) {
      return {
        score: 20,
        reason: 'Très proche du client.',
      };
    }

    if (distanceKm <= 10) {
      return {
        score: 17,
        reason: 'Proche du client.',
      };
    }

    if (distanceKm <= 20) {
      return {
        score: 12,
        reason: 'Distance acceptable.',
      };
    }

    if (distanceKm <= 50) {
      return {
        score: 6,
        reason: 'Distance élevée.',
      };
    }

    return {
      score: 2,
      reason: 'Très loin du client.',
    };
  }

  private serviceZoneMatch(params: {
    clientLatitude?: number;
    clientLongitude?: number;
    zones: {
      latitude: number | null;
      longitude: number | null;
      radiusKm: number;
      city: string | null;
      postalCode: string | null;
      isActive: boolean;
    }[];
  }) {
    const activeZones = params.zones.filter((zone) => zone.isActive);

    if (!activeZones.length) {
      return {
        matches: true,
        score: 8,
        reason: 'Aucune zone configurée, artisan accepté par défaut.',
      };
    }

    if (
      params.clientLatitude === undefined ||
      params.clientLongitude === undefined
    ) {
      return {
        matches: true,
        score: 5,
        reason: 'Coordonnées client non disponibles.',
      };
    }

    for (const zone of activeZones) {
      if (zone.latitude === null || zone.longitude === null) {
        continue;
      }

      const distance = this.haversineKm({
        lat1: params.clientLatitude,
        lng1: params.clientLongitude,
        lat2: zone.latitude,
        lng2: zone.longitude,
      });

      if (distance <= zone.radiusKm) {
        return {
          matches: true,
          score: 10,
          reason: `Client dans la zone de service (${distance.toFixed(1)} km).`,
        };
      }
    }

    return {
      matches: false,
      score: 0,
      reason: 'Client hors zone de service.',
    };
  }

  private weeklyAvailabilityMatch(params: {
    startsAt?: Date;
    endsAt?: Date;
    availability: {
      dayOfWeek: any;
      startTime: string;
      endTime: string;
      isAvailable: boolean;
    }[];
  }) {
    if (!params.startsAt || !params.endsAt) {
      return {
        matches: true,
        score: 8,
        reason: 'Aucun créneau précis demandé.',
      };
    }

    const availableSlots = params.availability.filter(
      (slot) => slot.isAvailable,
    );

    if (!availableSlots.length) {
      return {
        matches: true,
        score: 8,
        reason: 'Aucun planning hebdomadaire configuré.',
      };
    }

    const dayOfWeek = this.jsDayToDayOfWeek(params.startsAt);
    const startTime = this.timeFromDate(params.startsAt);
    const endTime = this.timeFromDate(params.endsAt);

    const matchingSlot = availableSlots.find(
      (slot) =>
        slot.dayOfWeek === dayOfWeek &&
        slot.startTime <= startTime &&
        slot.endTime >= endTime,
    );

    if (matchingSlot) {
      return {
        matches: true,
        score: 10,
        reason: 'Disponible sur ce créneau hebdomadaire.',
      };
    }

    return {
      matches: false,
      score: 0,
      reason: 'Pas disponible sur ce créneau hebdomadaire.',
    };
  }

  private availabilityStatusScore(params: {
    availabilityStatus: ArtisanAvailabilityStatus;
    isAcceptingJobs: boolean;
    emergencyAvailable: boolean;
    emergency?: boolean;
  }) {
    if (!params.isAcceptingJobs) {
      return {
        score: 0,
        reason: 'Artisan ne prend pas de missions.',
      };
    }

    if (params.emergency && params.emergencyAvailable) {
      return {
        score: 10,
        reason: 'Disponible pour urgence.',
      };
    }

    if (params.availabilityStatus === ArtisanAvailabilityStatus.ONLINE) {
      return {
        score: 8,
        reason: 'Artisan en ligne.',
      };
    }

    if (params.availabilityStatus === ArtisanAvailabilityStatus.BUSY) {
      return {
        score: 4,
        reason: 'Artisan occupé mais actif.',
      };
    }

    if (params.availabilityStatus === ArtisanAvailabilityStatus.OFFLINE) {
      return {
        score: 2,
        reason: 'Artisan hors ligne.',
      };
    }

    return {
      score: 0,
      reason: 'Artisan indisponible.',
    };
  }

  private ratingScore(averageRating: number) {
    if (averageRating >= 4.8) {
      return 10;
    }

    if (averageRating >= 4.5) {
      return 9;
    }

    if (averageRating >= 4.0) {
      return 7;
    }

    if (averageRating >= 3.5) {
      return 5;
    }

    if (averageRating > 0) {
      return 3;
    }

    return 4;
  }

  private activeJobsScore(activeJobs: number, maxActiveJobs: number) {
    if (activeJobs <= 0) {
      return {
        score: 5,
        reason: 'Aucune mission active.',
      };
    }

    if (activeJobs < maxActiveJobs) {
      return {
        score: 3,
        reason: `${activeJobs} mission(s) active(s).`,
      };
    }

    return {
      score: 0,
      reason: 'Charge de travail élevée.',
    };
  }

  private validateMatchingContext(context: MatchingContext) {
    if (!context.serviceType) {
      throw new BadRequestException('serviceType est obligatoire.');
    }

    if (
      (context.startsAt && !context.endsAt) ||
      (!context.startsAt && context.endsAt)
    ) {
      throw new BadRequestException(
        'startsAt et endsAt doivent être fournis ensemble.',
      );
    }

    if (context.startsAt && context.endsAt && context.startsAt >= context.endsAt) {
      throw new BadRequestException('Créneau invalide.');
    }
  }

  // ==========================================================
  // Core matching
  // ==========================================================

  async findMatchingArtisans(
    userId: number,
    role: Role,
    query: MatchArtisansQueryDto,
  ) {
    this.assertStaff(role);

    const range = this.parseRange(query.startsAt, query.endsAt);

    const context: MatchingContext = {
      serviceType: query.serviceType!,
      specialty: query.specialty,
      latitude:
        query.latitude !== undefined ? Number(query.latitude) : undefined,
      longitude:
        query.longitude !== undefined ? Number(query.longitude) : undefined,
      startsAt: range.startsAt,
      endsAt: range.endsAt,
      emergency: query.emergency ?? false,
      onlyAvailable: query.onlyAvailable ?? false,
      limit: query.limit || 10,
    };

    this.validateMatchingContext(context);

    return this.computeMatches(context);
  }

  async findMatchingArtisansForIntervention(
    userId: number,
    role: Role,
    interventionId: number,
    query: MatchArtisansQueryDto,
  ) {
    this.assertStaff(role);

    const intervention = await this.prisma.intervention.findUnique({
      where: {
        id: interventionId,
      },
      include: {
        subService: true,
        appointment: true,
      },
    });

    if (!intervention) {
      throw new NotFoundException('Intervention introuvable.');
    }

    const queryRange = this.parseRange(query.startsAt, query.endsAt);

    const appointmentRange: MatchingRange =
      intervention.appointment?.startsAt && intervention.appointment?.endsAt
        ? {
            startsAt: intervention.appointment.startsAt,
            endsAt: intervention.appointment.endsAt,
          }
        : {};

    const preferredRange = this.combinePreferredDateAndTime(
      intervention.preferredDate,
      intervention.preferredStartTime,
      intervention.preferredEndTime,
    );

    const startsAt =
      queryRange.startsAt ||
      appointmentRange.startsAt ||
      preferredRange.startsAt;

    const endsAt =
      queryRange.endsAt ||
      appointmentRange.endsAt ||
      preferredRange.endsAt;

    const context: MatchingContext = {
      serviceType: intervention.serviceType,
      specialty: query.specialty || intervention.subService?.name,
      latitude:
        query.latitude !== undefined
          ? Number(query.latitude)
          : intervention.latitude ?? undefined,
      longitude:
        query.longitude !== undefined
          ? Number(query.longitude)
          : intervention.longitude ?? undefined,
      startsAt,
      endsAt,
      emergency:
        query.emergency ?? intervention.urgency === 'EMERGENCY',
      onlyAvailable: query.onlyAvailable ?? false,
      limit: query.limit || 10,
    };

    this.validateMatchingContext(context);

    const matches = await this.computeMatches(context);

    return {
      interventionId,
      serviceType: intervention.serviceType,
      urgency: intervention.urgency,
      requestedSlot:
        startsAt && endsAt
          ? {
              startsAt,
              endsAt,
            }
          : null,
      matches,
    };
  }

  private async computeMatches(context: MatchingContext) {
    const overlappingAppointmentWhere =
      context.startsAt && context.endsAt
        ? {
            startsAt: {
              lt: context.endsAt,
            },
            endsAt: {
              gt: context.startsAt,
            },
            status: {
              in: this.activeAppointmentStatuses(),
            },
          }
        : {
            id: -1,
          };

    const overlappingTimeBlockWhere =
      context.startsAt && context.endsAt
        ? {
            startsAt: {
              lt: context.endsAt,
            },
            endsAt: {
              gt: context.startsAt,
            },
          }
        : {
            id: -1,
          };

    const artisans = await this.prisma.user.findMany({
      where: {
        role: Role.ARTISAN,
        isActive: true,
        deletedAt: null,
        artisanProfile: {
          is: {
            verificationStatus: ArtisanVerificationStatus.APPROVED,
          },
        },
      },
      include: {
        artisanProfile: {
          include: {
            serviceZones: true,
            availability: true,
          },
        },
        artisanInterventions: {
          where: {
            status: {
              in: this.activeInterventionStatuses(),
            },
          },
          select: {
            id: true,
            status: true,
            serviceType: true,
            address: true,
            createdAt: true,
          },
        },
        artisanAppointments: {
          where: overlappingAppointmentWhere,
          select: {
            id: true,
            startsAt: true,
            endsAt: true,
            status: true,
            interventionId: true,
          },
        },
        artisanTimeBlocks: {
          where: overlappingTimeBlockWhere,
          select: {
            id: true,
            startsAt: true,
            endsAt: true,
            type: true,
            reason: true,
          },
        },
      },
    });

    const scored = artisans
      .map((artisan) => {
        const profile = artisan.artisanProfile;

        if (!profile) {
          return null;
        }

        const reasons: string[] = [];
        const hardIssues: string[] = [];

        const specialtyMatch = this.specialtyMatches({
          serviceType: context.serviceType,
          requiredSpecialty: context.specialty,
          artisanServiceTypes: profile.serviceTypes || [],
          specialty: profile.specialty,
          specialties: profile.specialties,
        });

        reasons.push(specialtyMatch.reason);

        if (!specialtyMatch.matches) {
          hardIssues.push(specialtyMatch.reason);
        }

        const distanceKm =
          context.latitude !== undefined &&
          context.longitude !== undefined &&
          artisan.latitude !== null &&
          artisan.longitude !== null
            ? this.haversineKm({
                lat1: context.latitude,
                lng1: context.longitude,
                lat2: artisan.latitude,
                lng2: artisan.longitude,
              })
            : null;

        const distance = this.distanceScore(distanceKm);
        reasons.push(distance.reason);

        const zone = this.serviceZoneMatch({
          clientLatitude: context.latitude,
          clientLongitude: context.longitude,
          zones: profile.serviceZones,
        });

        reasons.push(zone.reason);

        if (!zone.matches) {
          hardIssues.push(zone.reason);
        }

        const weeklyAvailability = this.weeklyAvailabilityMatch({
          startsAt: context.startsAt,
          endsAt: context.endsAt,
          availability: profile.availability,
        });

        reasons.push(weeklyAvailability.reason);

        if (!weeklyAvailability.matches) {
          hardIssues.push(weeklyAvailability.reason);
        }

        const overlappingAppointments = artisan.artisanAppointments.length;
        const overlappingTimeBlocks = artisan.artisanTimeBlocks.length;

        if (overlappingAppointments > 0) {
          hardIssues.push('Artisan déjà réservé sur ce créneau.');
          reasons.push('Conflit avec un rendez-vous existant.');
        }

        if (overlappingTimeBlocks > 0) {
          hardIssues.push('Artisan indisponible sur ce créneau.');
          reasons.push('Conflit avec un bloc d’indisponibilité.');
        }

        const availabilityStatus = this.availabilityStatusScore({
          availabilityStatus: profile.availabilityStatus,
          isAcceptingJobs: profile.isAcceptingJobs,
          emergencyAvailable: profile.emergencyAvailable,
          emergency: context.emergency,
        });

        reasons.push(availabilityStatus.reason);

        if (!profile.isAcceptingJobs) {
          hardIssues.push('Artisan ne prend pas de missions.');
        }

        if (
          context.emergency &&
          !profile.emergencyAvailable
        ) {
          hardIssues.push('Artisan non disponible pour urgence.');
        }

        const activeJobsCount = artisan.artisanInterventions.length;

        const activeJobs = this.activeJobsScore(
          activeJobsCount,
          profile.maxActiveJobs,
        );

        reasons.push(activeJobs.reason);

        if (activeJobsCount >= profile.maxActiveJobs) {
          hardIssues.push('Artisan au maximum de missions actives.');
        }

        const verificationScore =
          profile.verificationStatus === ArtisanVerificationStatus.APPROVED
            ? 15
            : 0;

        const rating = this.ratingScore(profile.averageRating);

        const emergencyScore =
          context.emergency && profile.emergencyAvailable
            ? 5
            : !context.emergency
              ? 3
              : 0;

        const availabilityTotal =
          weeklyAvailability.score +
          availabilityStatus.score -
          overlappingAppointments * 10 -
          overlappingTimeBlocks * 10;

        const score =
          specialtyMatch.score +
          distance.score +
          zone.score +
          Math.max(0, availabilityTotal) +
          verificationScore +
          rating +
          activeJobs.score +
          emergencyScore;

        const estimatedArrivalMinutes = this.estimateArrivalMinutes(
          distanceKm,
          Boolean(context.emergency),
          profile.availabilityStatus,
        );

        const isAvailable =
          hardIssues.length === 0 &&
          profile.isAcceptingJobs &&
          overlappingAppointments === 0 &&
          overlappingTimeBlocks === 0;

        return {
          artisanId: artisan.id,
          name: artisan.name,
          email: artisan.email,
          phone: artisan.phone,

          score: Math.max(0, Math.min(100, Math.round(score))),
          isAvailable,

          distanceKm:
            distanceKm === null ? null : Number(distanceKm.toFixed(2)),

          estimatedArrivalMinutes,

          currentStatus: profile.availabilityStatus,
          isAcceptingJobs: profile.isAcceptingJobs,
          emergencyAvailable: profile.emergencyAvailable,

          verificationStatus: profile.verificationStatus,

          rating: profile.averageRating,
          completedJobsCount: profile.completedJobsCount,
          cancelledJobsCount: profile.cancelledJobsCount,

          activeJobsCount,
          maxActiveJobs: profile.maxActiveJobs,

          specialty: profile.specialty,
          specialties: profile.specialties,
          serviceTypes: profile.serviceTypes,

          serviceZones: profile.serviceZones,

          conflicts: {
            overlappingAppointments,
            overlappingTimeBlocks,
          },

          hardIssues,
          reasons,

          scoreBreakdown: {
            service: specialtyMatch.score,
            distance: distance.score,
            serviceZone: zone.score,
            availability: Math.max(0, availabilityTotal),
            verification: verificationScore,
            rating,
            activeJobs: activeJobs.score,
            emergency: emergencyScore,
          },
        };
      })
      .filter(Boolean) as any[];

    const filtered = context.onlyAvailable
      ? scored.filter((candidate) => candidate.isAvailable)
      : scored;

    return filtered
      .sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }

        if (a.distanceKm === null && b.distanceKm !== null) {
          return 1;
        }

        if (a.distanceKm !== null && b.distanceKm === null) {
          return -1;
        }

        return (a.distanceKm || 9999) - (b.distanceKm || 9999);
      })
      .slice(0, context.limit || 10);
  }

  // ==========================================================
  // Assignment helpers
  // ==========================================================

  async assignBestArtisan(
    userId: number,
    role: Role,
    interventionId: number,
    dto: AssignMatchedArtisanDto,
  ) {
    this.assertStaff(role);

    const result = await this.findMatchingArtisansForIntervention(
      userId,
      role,
      interventionId,
      {
        startsAt: dto.startsAt,
        endsAt: dto.endsAt,
        onlyAvailable: true,
        limit: 1,
      },
    );

    const best = result.matches[0];

    if (!best) {
      throw new BadRequestException(
        'Aucun artisan disponible ne correspond à cette intervention.',
      );
    }

    return this.assignArtisan(
      userId,
      role,
      interventionId,
      best.artisanId,
      dto,
    );
  }

  async assignArtisan(
    userId: number,
    role: Role,
    interventionId: number,
    artisanId: number,
    dto: AssignMatchedArtisanDto,
  ) {
    this.assertStaff(role);

    const intervention = await this.prisma.intervention.findUnique({
      where: {
        id: interventionId,
      },
      include: {
        appointment: true,
      },
    });

    if (!intervention) {
      throw new NotFoundException('Intervention introuvable.');
    }

    const artisan = await this.prisma.user.findFirst({
      where: {
        id: artisanId,
        role: Role.ARTISAN,
        isActive: true,
        deletedAt: null,
        artisanProfile: {
          is: {
            verificationStatus: ArtisanVerificationStatus.APPROVED,
          },
        },
      },
      include: {
        artisanProfile: true,
      },
    });

    if (!artisan || !artisan.artisanProfile) {
      throw new NotFoundException('Artisan introuvable ou non vérifié.');
    }

    const range = this.parseRange(dto.startsAt, dto.endsAt);

    if (range.startsAt && range.endsAt) {
      const matches = await this.computeMatches({
        serviceType: intervention.serviceType,
        latitude: intervention.latitude ?? undefined,
        longitude: intervention.longitude ?? undefined,
        startsAt: range.startsAt,
        endsAt: range.endsAt,
        emergency: intervention.urgency === 'EMERGENCY',
        onlyAvailable: false,
        limit: 100,
      });

      const selected = matches.find((item) => item.artisanId === artisanId);

      if (!selected) {
        throw new BadRequestException(
          'Cet artisan ne correspond pas à cette intervention.',
        );
      }

      if (!selected.isAvailable) {
        throw new BadRequestException({
          message: 'Cet artisan n’est pas disponible.',
          issues: selected.hardIssues,
          candidate: selected,
        });
      }
    }

    const updated = await this.prisma.intervention.update({
      where: {
        id: interventionId,
      },
      data: {
        artisanId,
        status: Status.ASSIGNED,
        assignedAt: new Date(),
        lastStatusChangedAt: new Date(),
      },
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
      },
    });

    if (range.startsAt && range.endsAt) {
      await this.prisma.appointment.upsert({
        where: {
          interventionId,
        },
        update: {
          artisanId,
          startsAt: range.startsAt,
          endsAt: range.endsAt,
          scheduledById: userId,
          adminNote: dto.adminNote,
          status: AppointmentStatus.SCHEDULED,
        },
        create: {
          interventionId,
          clientId: intervention.clientId,
          artisanId,
          startsAt: range.startsAt,
          endsAt: range.endsAt,
          scheduledById: userId,
          adminNote: dto.adminNote,
          status: AppointmentStatus.SCHEDULED,
        },
      });
    }

    await this.realtime?.emitStatusChange?.({
      interventionId,
      oldStatus: intervention.status,
      newStatus: Status.ASSIGNED,
      actorId: userId,
    });

    return updated;
  }
}