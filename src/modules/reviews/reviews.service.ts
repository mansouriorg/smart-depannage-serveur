import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateReviewDto } from './dto/create-review.dto';
import { InterventionEventsService } from '../intervention-events/intervention-events.service';
import {
  InterventionEventType,
  Status,
} from '../../../generated/prisma/client';

@Injectable()
export class ReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: InterventionEventsService,
  ) {}

  async create(clientId: number, interventionId: number, dto: CreateReviewDto) {
    const intervention = await this.prisma.intervention.findUnique({
      where: { id: interventionId },
      include: {
        review: true,
      },
    });

    if (!intervention) {
      throw new NotFoundException('Intervention introuvable.');
    }

    if (intervention.clientId !== clientId) {
      throw new ForbiddenException('Accès refusé.');
    }

    if (
      intervention.status !== Status.COMPLETED &&
      intervention.status !== Status.PAID &&
      intervention.status !== Status.INVOICE_READY
    ) {
      throw new BadRequestException(
        'Vous pouvez noter uniquement une intervention terminée.',
      );
    }

    if (intervention.review) {
      throw new BadRequestException(
        'Un avis existe déjà pour cette intervention.',
      );
    }

    const review = await this.prisma.review.create({
      data: {
        interventionId,
        clientId,
        artisanId: intervention.artisanId,
        rating: dto.rating,
        isOnTime: dto.isOnTime,
        comment: dto.comment,
        wouldRecommend: dto.wouldRecommend,
      },
    });

    await this.prisma.intervention.update({
      where: { id: interventionId },
      data: {
        rating: dto.rating,
        isOnTime: dto.isOnTime,
        feedbackNotes: dto.comment,
      },
    });

    await this.events.create({
      interventionId,
      type: InterventionEventType.REVIEW_SUBMITTED,
      title: 'Avis reçu',
      message: `Le client a laissé une note de ${dto.rating}/5.`,
      createdById: clientId,
    });

    return review;
  }

  async findArtisanReviews(artisanId: number) {
    return this.prisma.review.findMany({
      where: {
        artisanId,
      },
      include: {
        client: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }
}