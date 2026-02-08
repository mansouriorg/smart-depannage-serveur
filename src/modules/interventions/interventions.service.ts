import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateInterventionDto } from './dto/create-intervention.dto';
import { UpdateInterventionDto } from './dto/update-intervention.dto';

@Injectable()
export class InterventionsService {
  constructor(private prisma: PrismaService) {}

  // 1. Create a new Request (Linked to the logged-in User)
  async create(userId: number, createInterventionDto: CreateInterventionDto) {
    return this.prisma.intervention.create({
      data: {
        ...createInterventionDto,
        // ⚠️ Prisma Magic: We use 'connect' to link this request to an existing User
        client: {
          connect: { id: userId },
        },
        // Status defaults to PENDING automatically based on your Schema
      },
    });
  }

  // 2. Find All (For Admins - shows everything)
  async findAll() {
    return this.prisma.intervention.findMany({
      include: {
        client: {
          select: { id: true, name: true, email: true }, // Hide sensitive password!
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // 3. Find My Requests (For Clients - only shows their own)
  async findByUser(userId: number) {
    return this.prisma.intervention.findMany({
      where: { clientId: userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // 4. Find Available Jobs (For Artisans - shows only PENDING jobs)
  async findAllPending() {
    return this.prisma.intervention.findMany({
      where: { status: 'PENDING' },
      include: {
        client: { select: { name: true, address: true } }, // Show client info
      },
    });
  }

  // 5. Get Single Request Details
  async findOne(id: number) {
    const intervention = await this.prisma.intervention.findUnique({
      where: { id },
      include: {
        client: { select: { id: true, name: true, phone: true } },
        artisan: { select: { id: true, name: true, phone: true } },
      },
    });

    if (!intervention) {
      throw new NotFoundException(`Intervention #${id} not found`);
    }

    return intervention;
  }

  // 6. Update (e.g., Artisan accepts job, or mark as Completed)
  async update(id: number, updateInterventionDto: UpdateInterventionDto) {
    return this.prisma.intervention.update({
      where: { id },
      data: updateInterventionDto,
    });
  }
}