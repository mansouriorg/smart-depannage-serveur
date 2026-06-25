import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { ReviewsService } from './reviews.service';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

import { Role } from '../../../generated/prisma/client';

import {
  CreateReviewDto,
  ModerateReviewDto,
  ReviewQueryDto,
} from './dto/review.dto';

@Controller('reviews')
@UseGuards(JwtAuthGuard)
export class ReviewsController {
  constructor(private readonly service: ReviewsService) {}

  // ==========================================================
  // Client: create review after completed intervention
  // ==========================================================

  /**
   * POST /reviews/interventions/:interventionId
   *
   * Body:
   * {
   *   "rating": 5,
   *   "comment": "Très bon travail.",
   *   "isOnTime": true,
   *   "isWorkClean": true,
   *   "isPriceRespected": true,
   *   "wouldRecommend": true
   * }
   */
  @Post('interventions/:interventionId')
  createReview(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('interventionId', ParseIntPipe) interventionId: number,
    @Body() dto: CreateReviewDto,
  ) {
    return this.service.createReview(
      userId,
      role,
      interventionId,
      dto,
    );
  }

  // ==========================================================
  // Client intervention history
  // ==========================================================

  /**
   * GET /reviews/me
   */
  @Get('me')
  findMyReviews(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
  ) {
    return this.service.findMyReviews(userId, role);
  }

  // ==========================================================
  // Artisan profile reviews
  // ==========================================================

  /**
   * GET /reviews/artisans/:artisanId
   */
  @Get('artisans/:artisanId')
  findVisibleArtisanReviews(
    @Param('artisanId', ParseIntPipe) artisanId: number,
  ) {
    return this.service.findVisibleArtisanReviews(artisanId);
  }

  /**
   * GET /reviews/artisans/:artisanId/summary
   */
  @Get('artisans/:artisanId/summary')
  getArtisanRatingSummary(
    @Param('artisanId', ParseIntPipe) artisanId: number,
  ) {
    return this.service.getArtisanRatingSummary(artisanId);
  }

  // ==========================================================
  // Review by intervention
  // ==========================================================

  /**
   * GET /reviews/interventions/:interventionId
   */
  @Get('interventions/:interventionId')
  findByIntervention(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('interventionId', ParseIntPipe) interventionId: number,
  ) {
    return this.service.findByIntervention(
      userId,
      role,
      interventionId,
    );
  }

  // ==========================================================
  // Admin dashboard
  // Must stay before GET /reviews/:reviewId
  // ==========================================================

  /**
   * GET /reviews/admin
   */
  @Get('admin')
  adminFindAll(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Query() query: ReviewQueryDto,
  ) {
    return this.service.adminFindAll(userId, role, query);
  }

  /**
   * GET /reviews/admin/dashboard
   */
  @Get('admin/dashboard')
  adminDashboard(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
  ) {
    return this.service.adminDashboard(userId, role);
  }

  /**
   * PATCH /reviews/admin/:reviewId/moderate
   *
   * Body:
   * {
   *   "status": "APPROVED",
   *   "moderationReason": "Avis validé."
   * }
   */
  @Patch('admin/:reviewId/moderate')
  moderateReview(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('reviewId', ParseIntPipe) reviewId: number,
    @Body() dto: ModerateReviewDto,
  ) {
    return this.service.moderateReview(
      userId,
      role,
      reviewId,
      dto,
    );
  }

  // ==========================================================
  // General review detail
  // Must stay after all specific GET routes
  // ==========================================================

  /**
   * GET /reviews/:reviewId
   */
  @Get(':reviewId')
  findOne(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('reviewId', ParseIntPipe) reviewId: number,
  ) {
    return this.service.findOne(userId, role, reviewId);
  }
}