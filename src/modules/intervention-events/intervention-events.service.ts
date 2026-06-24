import { Injectable } from '@nestjs/common';
import { InterventionEventType, Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class InterventionEventsService {
  constructor(private readonly prisma: PrismaService) {}

  create(data: {
    interventionId: number;
    type: InterventionEventType;
    title: string;
    message?: string;
    createdById?: number;
    metadata?: Prisma.InputJsonValue;
  }) {
    return this.prisma.interventionEvent.create({
      data,
    });
  }

  findByIntervention(interventionId: number) {
    return this.prisma.interventionEvent.findMany({
      where: { interventionId },
      orderBy: { createdAt: 'asc' },
    });
  }
}