import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { getBusinessTimeZone } from '../../config/env';
import { normalizeTradeText, textPointsToTrade } from '../../common/trades/trades';
import { distanceKm } from '../../common/geo/distance';
import { ZoneCircle, zoneVerdict } from '../../common/geo/zone-match';
import {
  WeeklySlot,
  checkWeeklySchedule,
  zonedInstant,
} from '../../common/availability/weekly-schedule';
import { AssignmentService } from '../assignment/assignment.service';
import {
  ACTIVE_APPOINTMENT_STATUSES,
  ACTIVE_JOB_STATUSES,
  artisanAvailabilityIssues,
} from '../assignment/artisan-availability';

import {
  ArtisanAvailabilityStatus,
  ArtisanVerificationStatus,
  Role,
  ServiceType,
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
  /** Only these artisans (to look at one name). */
  artisanIds?: number[];
  /** The job being decided: its own appointment and its own place in the artisan's load do not count against them. */
  excludeInterventionId?: number;
};

@Injectable()
export class MatchingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly assignment: AssignmentService,
  ) {}

  // ==========================================================
  // Helpers
  // ==========================================================

  private isStaff(role: Role): boolean {
    const staffRoles: Role[] = [
      Role.ADMIN,
      Role.SUPER_ADMIN,
      Role.SUPPORT,
      Role.DISPATCHER,
      Role.ACCOUNTANT,
    ];

    return staffRoles.includes(role);
  }

  private assertStaff(role: Role) {
    if (!this.isStaff(role)) {
      throw new ForbiddenException('Accès réservé à l’administration.');
    }
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
    const timeZone = getBusinessTimeZone();

    // The client wrote the hours on the clock of the country, not on the UTC clock.
    const startsAt = zonedInstant(day, preferredStartTime, timeZone);
    const endsAt = zonedInstant(day, preferredEndTime, timeZone);

    if (!startsAt || !endsAt || startsAt >= endsAt) {
      return {};
    }

    return {
      startsAt,
      endsAt,
    };
  }

  private haversineKm(params: {
    lat1: number;
    lng1: number;
    lat2: number;
    lng2: number;
  }): number {
    return distanceKm(params.lat1, params.lng1, params.lat2, params.lng2);
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

  /** Compared the way the table of trades does it: no accents, no capitals, "chauffe-eau" = "chauffe eau". */
  private normalizeText(value?: string | null): string {
    return normalizeTradeText(value);
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

    const allSpecialties = [params.specialty, ...(params.specialties || [])]
      .filter(Boolean)
      .map((item) => this.normalizeText(item));

    // The words that point to the service type of the job come from the one table of trades (P1-10).
    const keywordMatch = allSpecialties.some((specialty) =>
      textPointsToTrade(specialty, params.serviceType),
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

  /**
   * The zones of the artisan against the position of the job: the rule is the one of the mission
   * board (common/geo/zone-match), only the score and the sentence are made here.
   */
  private serviceZoneMatch(params: {
    clientLatitude?: number;
    clientLongitude?: number;
    zones: ZoneCircle[];
  }) {
    const verdict = zoneVerdict(params.zones, {
      latitude: params.clientLatitude,
      longitude: params.clientLongitude,
    });

    switch (verdict.kind) {
      case 'unrestricted':
        return {
          matches: true,
          score: 8,
          reason: 'Aucune zone configurée, artisan accepté par défaut.',
        };

      case 'unknown-position':
        return {
          matches: true,
          score: 5,
          reason: 'Coordonnées client non disponibles.',
        };

      case 'inside':
        return {
          matches: true,
          score: 10,
          reason: `Client dans la zone de service (${verdict.distanceKm.toFixed(1)} km).`,
        };

      default:
        return {
          matches: false,
          score: 0,
          reason: 'Client hors zone de service.',
        };
    }
  }

  /**
   * The score and the sentence for the weekly hours. Whether the artisan is free
   * is decided by artisanAvailabilityIssues (one rule shared with the assignment).
   */
  private weeklyAvailabilityMatch(params: {
    startsAt?: Date;
    endsAt?: Date;
    availability: readonly WeeklySlot[];
  }) {
    if (!params.startsAt || !params.endsAt) {
      return {
        score: 8,
        reason: 'Aucun créneau précis demandé.',
      };
    }

    const verdict = checkWeeklySchedule(
      params.availability,
      params.startsAt,
      params.endsAt,
      getBusinessTimeZone(),
    );

    if (!verdict.configured) {
      return { score: 8, reason: verdict.reason };
    }

    return { score: verdict.ok ? 10 : 0, reason: verdict.reason };
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

    if (
      context.startsAt &&
      context.endsAt &&
      context.startsAt >= context.endsAt
    ) {
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
      queryRange.endsAt || appointmentRange.endsAt || preferredRange.endsAt;

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
      emergency: query.emergency ?? intervention.urgency === 'EMERGENCY',
      onlyAvailable: query.onlyAvailable ?? false,
      limit: query.limit || 10,
      excludeInterventionId: interventionId,
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
              in: ACTIVE_APPOINTMENT_STATUSES,
            },
            ...(context.excludeInterventionId !== undefined
              ? { interventionId: { not: context.excludeInterventionId } }
              : {}),
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
        ...(context.artisanIds ? { id: { in: context.artisanIds } } : {}),
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
            // Did this artisan already refuse the job being matched? (P1-06)
            missionRejections:
              context.excludeInterventionId !== undefined
                ? { where: { interventionId: context.excludeInterventionId }, select: { id: true }, take: 1 }
                : false,
          },
        },
        artisanInterventions: {
          where: {
            status: {
              in: ACTIVE_JOB_STATUSES,
            },
            ...(context.excludeInterventionId !== undefined
              ? { id: { not: context.excludeInterventionId } }
              : {}),
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

        // Does the artisan fit the job itself (kind of work, place)? Time and load come next.
        const serviceFit = specialtyMatch.matches && zone.matches;

        const weeklyAvailability = this.weeklyAvailabilityMatch({
          startsAt: context.startsAt,
          endsAt: context.endsAt,
          availability: profile.availability,
        });

        reasons.push(weeklyAvailability.reason);

        const overlappingAppointments = artisan.artisanAppointments.length;
        const overlappingTimeBlocks = artisan.artisanTimeBlocks.length;

        if (overlappingAppointments > 0) {
          reasons.push('Conflit avec un rendez-vous existant.');
        }

        if (overlappingTimeBlocks > 0) {
          reasons.push('Conflit avec un bloc d’indisponibilité.');
        }

        const availabilityStatus = this.availabilityStatusScore({
          availabilityStatus: profile.availabilityStatus,
          isAcceptingJobs: profile.isAcceptingJobs,
          emergencyAvailable: profile.emergencyAvailable,
          emergency: context.emergency,
        });

        reasons.push(availabilityStatus.reason);

        const activeJobsCount = artisan.artisanInterventions.length;

        const activeJobs = this.activeJobsScore(
          activeJobsCount,
          profile.maxActiveJobs,
        );

        reasons.push(activeJobs.reason);

        // An artisan who refused (or gave back) this job is not proposed for it again: the
        // automatic choice skips them, and the dispatcher still sees why. Giving them the job
        // on purpose stays possible (the assignment does not read this).
        if ((profile as any).missionRejections?.length) {
          reasons.push('A déjà refusé cette mission.');
          hardIssues.push('A déjà refusé cette mission.');
        }

        // The same rule as the assignment: what is listed as free can be assigned.
        hardIssues.push(
          ...artisanAvailabilityIssues({
            profile: {
              isAcceptingJobs: profile.isAcceptingJobs,
              emergencyAvailable: profile.emergencyAvailable,
              maxActiveJobs: profile.maxActiveJobs,
              availability: profile.availability,
            },
            activeJobsCount,
            overlappingAppointments,
            overlappingTimeBlocks,
            range:
              context.startsAt && context.endsAt
                ? { startsAt: context.startsAt, endsAt: context.endsAt }
                : undefined,
            emergency: context.emergency,
            timeZone: getBusinessTimeZone(),
          }),
        );

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

        const isAvailable = hardIssues.length === 0;

        return {
          artisanId: artisan.id,
          name: artisan.name,
          email: artisan.email,
          phone: artisan.phone,

          score: Math.max(0, Math.min(100, Math.round(score))),
          isAvailable,
          serviceFit,

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

  /**
   * Gives the job to this artisan, through the one assignment path (P1-05): the
   * artisan must be approved and free, and the job in a status that can be
   * assigned. This route also insists that the artisan fits the job (kind of work
   * and place), since "matched" is what it is for.
   */
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
      select: {
        id: true,
        serviceType: true,
        latitude: true,
        longitude: true,
        urgency: true,
      },
    });

    if (!intervention) {
      throw new NotFoundException('Intervention introuvable.');
    }

    const [candidate] = await this.computeMatches({
      serviceType: intervention.serviceType,
      latitude: intervention.latitude ?? undefined,
      longitude: intervention.longitude ?? undefined,
      emergency: intervention.urgency === 'EMERGENCY',
      artisanIds: [artisanId],
      excludeInterventionId: interventionId,
      onlyAvailable: false,
      limit: 1,
    });

    if (!candidate) {
      throw new NotFoundException('Artisan introuvable ou non vérifié.');
    }

    if (!candidate.serviceFit) {
      throw new BadRequestException(
        'Cet artisan ne correspond pas à cette intervention.',
      );
    }

    const result = await this.assignment.assign({
      interventionId,
      artisanId,
      actorId: userId,
      startsAt: dto.startsAt,
      endsAt: dto.endsAt,
      adminNote: dto.adminNote,
      expectedArtisanId: dto.expectedArtisanId,
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

    return result.intervention;
  }
}
