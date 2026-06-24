import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ReviewsService } from './reviews.service';
import { CreateReviewDto } from './dto/create-review.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Role } from '../../../generated/prisma/client';

@Controller('reviews')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ReviewsController {
  constructor(private readonly service: ReviewsService) {}

  @Roles(Role.CLIENT, Role.ADMIN, Role.SUPER_ADMIN)
  @Post('interventions/:interventionId')
  create(
    @CurrentUser('id') userId: number,
    @Param('interventionId', ParseIntPipe) interventionId: number,
    @Body() dto: CreateReviewDto,
  ) {
    return this.service.create(userId, interventionId, dto);
  }

  @Roles(
    Role.CLIENT,
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
  )
  @Get('artisans/:artisanId')
  findArtisanReviews(@Param('artisanId', ParseIntPipe) artisanId: number) {
    return this.service.findArtisanReviews(artisanId);
  }
}