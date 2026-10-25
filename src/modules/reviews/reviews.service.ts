import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { reviewForAuthor, reviewForPublic, reviewForSubject } from '../../common/views/views';

import {
  Prisma,
  ReviewModerationStatus,
  Role,
  Status,
} from '../../../generated/prisma/client';

import {
  CreateReviewDto,
  ModerateReviewDto,
  ReviewQueryDto,
} from './dto/review.dto';
import { withoutNul } from '../../common/search/staff-search';
import { REVIEW_STATUSES, moderationReasonProblem, reviewBaseWhere, reviewPaging, reviewQueueOrder, reviewQueueWhere } from './review-queue';

@Injectable()
export class ReviewsService {
  constructor(private readonly prisma: PrismaService) {}

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

  private completedStatuses(): Status[] {
    return [
      Status.COMPLETED,
      Status.PAID,
      Status.INVOICE_SENT,
      Status.INVOICE_READY,
    ];
  }

  private async getInterventionOrFail(interventionId: number) {
    const intervention = await this.prisma.intervention.findUnique({
      where: {
        id: interventionId,
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
            role: true,
          },
        },
        review: true,
      },
    });

    if (!intervention) {
      throw new NotFoundException('Intervention introuvable.');
    }

    return intervention;
  }

  private async checkInterventionAccess(
    userId: number,
    role: Role,
    interventionId: number,
  ) {
    const intervention = await this.getInterventionOrFail(interventionId);

    const isClient = intervention.clientId === userId;
    const isArtisan = intervention.artisanId === userId;
    const isStaff = this.isStaff(role);

    if (!isClient && !isArtisan && !isStaff) {
      throw new ForbiddenException('Accès refusé.');
    }

    return intervention;
  }

  /**
   * A review that has been approved, as somebody who is not the back office and did not write it
   * reads it: the artisan it is about sees the customer's name; anybody else sees stars, words
   * and a first name, never a number, an e-mail or an address.
   */
  private forReader(userId: number, role: Role, review: any) {
    return role === Role.ARTISAN && review.artisanId === userId
      ? reviewForSubject(review)
      : reviewForPublic(review);
  }

  private reviewInclude() {
    return {
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
          artisanProfile: {
            select: {
              specialty: true,
              specialties: true,
              averageRating: true,
              ratingCount: true,
              completedJobsCount: true,
            },
          },
        },
      },
      intervention: {
        select: {
          id: true,
          description: true,
          address: true,
          serviceType: true,
          status: true,
          createdAt: true,
          workCompletedAt: true,
          paidAt: true,
        },
      },
    } satisfies Prisma.ReviewInclude;
  }

  private async getReviewOrFail(reviewId: number) {
    const review = await this.prisma.review.findUnique({
      where: {
        id: reviewId,
      },
      include: this.reviewInclude(),
    });

    if (!review) {
      throw new NotFoundException('Avis introuvable.');
    }

    return review;
  }

  private async recalculateArtisanRatingStats(artisanId?: number | null) {
    if (!artisanId) {
      return;
    }

    const reviews = await this.prisma.review.findMany({
      where: {
        artisanId,
        status: ReviewModerationStatus.APPROVED,
        isVisible: true,
      },
      select: {
        rating: true,
      },
    });

    const ratingCount = reviews.length;

    const averageRating =
      ratingCount === 0
        ? 0
        : reviews.reduce((sum, review) => sum + review.rating, 0) /
          ratingCount;

    await this.prisma.artisanProfile.updateMany({
      where: {
        userId: artisanId,
      },
      data: {
        averageRating: Number(averageRating.toFixed(2)),
        ratingCount,
      },
    });
  }

  private reviewVisibilityWhereForUser(
    userId: number,
    role: Role,
  ): Prisma.ReviewWhereInput {
    if (this.isStaff(role)) {
      return {};
    }

    if (role === Role.CLIENT) {
      return {
        OR: [
          {
            clientId: userId,
          },
          {
            isVisible: true,
            status: ReviewModerationStatus.APPROVED,
          },
        ],
      };
    }

    if (role === Role.ARTISAN) {
      return {
        OR: [
          {
            artisanId: userId,
            isVisible: true,
            status: ReviewModerationStatus.APPROVED,
          },
        ],
      };
    }

    return {
      isVisible: true,
      status: ReviewModerationStatus.APPROVED,
    };
  }

  // ==========================================================
  // Client: create review
  // ==========================================================

  async createReview(
    userId: number,
    role: Role,
    interventionId: number,
    dto: CreateReviewDto,
  ) {
    if (role !== Role.CLIENT) {
      throw new ForbiddenException('Seul le client peut laisser un avis.');
    }

    const intervention = await this.getInterventionOrFail(interventionId);

    if (intervention.clientId !== userId) {
      throw new ForbiddenException(
        'Vous ne pouvez évaluer que vos propres interventions.',
      );
    }

    if (!intervention.artisanId) {
      throw new BadRequestException(
        'Impossible de noter une intervention sans artisan assigné.',
      );
    }

    if (!this.completedStatuses().includes(intervention.status)) {
      throw new BadRequestException(
        'Vous pouvez laisser un avis uniquement après la fin de l’intervention.',
      );
    }

    if (intervention.review) {
      throw new ConflictException(
        'Un avis existe déjà pour cette intervention.',
      );
    }

    const review = await this.prisma.review.create({
      data: {
        interventionId,
        clientId: userId,
        artisanId: intervention.artisanId,

        rating: dto.rating,
        comment: dto.comment?.trim() || null,

        isOnTime: dto.isOnTime,
        isWorkClean: dto.isWorkClean,
        isPriceRespected: dto.isPriceRespected,
        wouldRecommend: dto.wouldRecommend,

        status: ReviewModerationStatus.PENDING,
        isVisible: false,
      },
      include: this.reviewInclude(),
    });

    return {
      message:
        'Votre avis a été envoyé. Il sera visible après validation par l’administration.',
      review: reviewForAuthor(review),
    };
  }

  // ==========================================================
  // Client / Artisan / Admin: intervention review
  // ==========================================================

  async findByIntervention(
    userId: number,
    role: Role,
    interventionId: number,
  ) {
    await this.checkInterventionAccess(userId, role, interventionId);

    const review = await this.prisma.review.findUnique({
      where: {
        interventionId,
      },
      include: this.reviewInclude(),
    });

    if (!review) {
      return null;
    }

    if (this.isStaff(role)) {
      return review;
    }

    if (role === Role.CLIENT && review.clientId === userId) {
      return reviewForAuthor(review);
    }

    if (
      review.isVisible &&
      review.status === ReviewModerationStatus.APPROVED
    ) {
      return this.forReader(userId, role, review);
    }

    return null;
  }

  // ==========================================================
  // Client: intervention history reviews
  // ==========================================================

  async findMyReviews(userId: number, role: Role) {
    if (role !== Role.CLIENT) {
      throw new ForbiddenException('Accès réservé au client.');
    }

    const reviews = await this.prisma.review.findMany({
      where: {
        clientId: userId,
      },
      include: this.reviewInclude(),
      orderBy: {
        createdAt: 'desc',
      },
    });

    return reviews.map((review) => reviewForAuthor(review));
  }

  // ==========================================================
  // Artisan profile: public reviews
  // ==========================================================

  async findVisibleArtisanReviews(artisanId: number) {
    const artisan = await this.prisma.user.findFirst({
      where: {
        id: artisanId,
        role: Role.ARTISAN,
        isActive: true,
        deletedAt: null,
      },
    });

    if (!artisan) {
      throw new NotFoundException('Artisan introuvable.');
    }

    const reviews = await this.prisma.review.findMany({
      where: {
        artisanId,
        status: ReviewModerationStatus.APPROVED,
        isVisible: true,
      },
      include: {
        client: {
          select: {
            id: true,
            name: true,
          },
        },
        intervention: {
          select: {
            id: true,
            serviceType: true,
            createdAt: true,
            workCompletedAt: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return reviews.map((review) => reviewForPublic(review));
  }

  async getArtisanRatingSummary(artisanId: number) {
    const profile = await this.prisma.artisanProfile.findUnique({
      where: {
        userId: artisanId,
      },
      select: {
        userId: true,
        specialty: true,
        specialties: true,
        averageRating: true,
        ratingCount: true,
        completedJobsCount: true,
        cancelledJobsCount: true,
      },
    });

    if (!profile) {
      throw new NotFoundException('Profil artisan introuvable.');
    }

    const reviews = await this.prisma.review.findMany({
      where: {
        artisanId,
        status: ReviewModerationStatus.APPROVED,
        isVisible: true,
      },
      select: {
        rating: true,
        isOnTime: true,
        isWorkClean: true,
        isPriceRespected: true,
        wouldRecommend: true,
      },
    });

    const count = reviews.length;

    const percentage = (value: number) => {
      if (count === 0) {
        return 0;
      }

      return Math.round((value / count) * 100);
    };

    const ratingDistribution = {
      1: reviews.filter((review) => review.rating === 1).length,
      2: reviews.filter((review) => review.rating === 2).length,
      3: reviews.filter((review) => review.rating === 3).length,
      4: reviews.filter((review) => review.rating === 4).length,
      5: reviews.filter((review) => review.rating === 5).length,
    };

    return {
      artisanId,
      averageRating: profile.averageRating,
      ratingCount: profile.ratingCount,
      completedJobsCount: profile.completedJobsCount,
      cancelledJobsCount: profile.cancelledJobsCount,

      ratingDistribution,

      qualityStats: {
        onTimePercentage: percentage(
          reviews.filter((review) => review.isOnTime === true).length,
        ),
        cleanWorkPercentage: percentage(
          reviews.filter((review) => review.isWorkClean === true).length,
        ),
        priceRespectedPercentage: percentage(
          reviews.filter((review) => review.isPriceRespected === true).length,
        ),
        recommendationPercentage: percentage(
          reviews.filter((review) => review.wouldRecommend === true).length,
        ),
      },
    };
  }

  // ==========================================================
  // Admin dashboard
  // ==========================================================

  async adminFindAll(
    userId: number,
    role: Role,
    query: ReviewQueryDto,
  ) {
    this.assertStaff(role);

    const where = reviewQueueWhere(query) as Prisma.ReviewWhereInput;
    const base = reviewBaseWhere(query) as Prisma.ReviewWhereInput[];

    const { skip, take } = reviewPaging(query);

    const [items, total, all, ...sizes] = await Promise.all([
      this.prisma.review.findMany({
        where,
        include: this.reviewInclude(),
        orderBy: reviewQueueOrder(query.sort),
        skip,
        take,
      }),
      this.prisma.review.count({
        where,
      }),
      // How many each tab holds under the same search and the same filters (the status of the tab is the one thing left out).
      this.prisma.review.count({ where: { AND: base } }),
      ...REVIEW_STATUSES.map((status) => this.prisma.review.count({ where: { AND: [...base, { status }] } })),
    ]);

    return {
      total,
      skip,
      take,
      items,
      counts: { all, ...Object.fromEntries(REVIEW_STATUSES.map((status, index) => [status, sizes[index]])) },
    };
  }

  async adminDashboard(userId: number, role: Role) {
    this.assertStaff(role);

    const [
      total,
      pending,
      approved,
      rejected,
      hidden,
      visible,
      average,
      latest,
    ] = await Promise.all([
      this.prisma.review.count(),
      this.prisma.review.count({
        where: {
          status: ReviewModerationStatus.PENDING,
        },
      }),
      this.prisma.review.count({
        where: {
          status: ReviewModerationStatus.APPROVED,
        },
      }),
      this.prisma.review.count({
        where: {
          status: ReviewModerationStatus.REJECTED,
        },
      }),
      this.prisma.review.count({
        where: {
          status: ReviewModerationStatus.HIDDEN,
        },
      }),
      this.prisma.review.count({
        where: {
          isVisible: true,
        },
      }),
      this.prisma.review.aggregate({
        where: {
          status: ReviewModerationStatus.APPROVED,
          isVisible: true,
        },
        _avg: {
          rating: true,
        },
      }),
      this.prisma.review.findMany({
        take: 10,
        orderBy: {
          createdAt: 'desc',
        },
        include: this.reviewInclude(),
      }),
    ]);

    return {
      totals: {
        total,
        pending,
        approved,
        rejected,
        hidden,
        visible,
      },
      averageVisibleRating: Number((average._avg.rating || 0).toFixed(2)),
      latest,
    };
  }

  async moderateReview(
    userId: number,
    role: Role,
    reviewId: number,
    dto: ModerateReviewDto,
  ) {
    this.assertStaff(role);

    // A review is turned away for a reason a person can read back later: the moderator says which.
    const problem = moderationReasonProblem(dto.status, dto.moderationReason);

    if (problem) throw new BadRequestException(problem);

    const existing = await this.getReviewOrFail(reviewId);

    const isVisible = dto.status === ReviewModerationStatus.APPROVED;

    const updated = await this.prisma.review.update({
      where: {
        id: reviewId,
      },
      data: {
        status: dto.status,
        isVisible,
        moderatedById: userId,
        moderatedAt: new Date(),
        // A NUL byte is refused by PostgreSQL (an error 500): it is dropped, as in the search boxes.
        moderationReason: withoutNul(dto.moderationReason ?? '').trim() || null,
      },
      include: this.reviewInclude(),
    });

    await this.recalculateArtisanRatingStats(existing.artisanId);

    return updated;
  }

  // ==========================================================
  // General access: find one review
  // ==========================================================

  async findOne(userId: number, role: Role, reviewId: number) {
    const review = await this.getReviewOrFail(reviewId);

    if (this.isStaff(role)) {
      return review;
    }

    if (role === Role.CLIENT && review.clientId === userId) {
      return reviewForAuthor(review);
    }

    if (
      review.status === ReviewModerationStatus.APPROVED &&
      review.isVisible
    ) {
      return this.forReader(userId, role, review);
    }

    throw new ForbiddenException('Accès refusé.');
  }
}
