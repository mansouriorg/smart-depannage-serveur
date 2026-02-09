import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateInterventionDto } from './dto/create-intervention.dto';
import { UpdateInterventionDto } from './dto/update-intervention.dto';
import { InterventionsGateway } from './interventions.gateway'; 
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class InterventionsService {
  constructor(
    private prisma: PrismaService,
    private gateway: InterventionsGateway,
    private notifications: NotificationsService,
  ) {}

  // 1. Create Request & Notify Admin/Artisans
  async create(userId: number, createInterventionDto: CreateInterventionDto) {
    // A. Save to Database
    const newIntervention = await this.prisma.intervention.create({
      data: {
        ...createInterventionDto,
        client: {
          connect: { id: userId },
        },
        status: 'PENDING',
      },
      include: {
        client: { select: { id: true, name: true, phone: true } },
      },
    });

    // B. 🔔 Real-Time Notification (WebSockets)
    // Updates the Admin Dashboard instantly without refresh
    this.gateway.server.emit('newIntervention', newIntervention);

    // C. 📱 SMS Notification
    // Notify the Admin that a new job has arrived
    // (In a real app, you might loop through nearby artisans here)
    await this.notifications.sendSms(
      '+21600000000', // Admin Phone (or fetch from ENV)
      `Alerte: Nouvelle demande de ${newIntervention.serviceType} à ${newIntervention.address}`
    );

    return newIntervention;
  }

  // 2. Find All (Admins)
  async findAll() {
    return this.prisma.intervention.findMany({
      include: {
        client: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // 3. Find My Requests (Clients)
  async findByUser(userId: number) {
    return this.prisma.intervention.findMany({
      where: { clientId: userId },
      include: {
        artisan: { select: { name: true, phone: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // 4. Find Available Jobs (Artisans)
  async findAllPending() {
    return this.prisma.intervention.findMany({
      where: { status: 'PENDING' },
      include: {
        // FIXED: Removed 'address: true' because address belongs to the intervention, not the user.
        client: { select: { name: true } },
      },
    });
  }

  // 5. Find Single Request
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

  // 6. Update Status (Accept Job / Finish Job)
  async update(id: number, updateInterventionDto: UpdateInterventionDto) {
    // Perform the update
    const updatedIntervention = await this.prisma.intervention.update({
      where: { id },
      data: updateInterventionDto,
      include: {
        client: { select: { id: true, name: true, phone: true } },
        artisan: { select: { id: true, name: true, phone: true } },
      },
    });

    // A. 🔔 Real-Time Notification
    // Notify the specific client watching this job
    this.gateway.server.emit(`interventionStatus-${id}`, updatedIntervention);

    // B. 📱 SMS Notification logic
    // If the status changed to ACCEPTED, tell the client their plumber is coming
    if (updateInterventionDto.status === 'ACCEPTED' && updatedIntervention.client.phone) {
      const artisanName = updatedIntervention.artisan?.name || 'Un artisan';
      await this.notifications.sendSms(
        updatedIntervention.client.phone,
        `Bonne nouvelle! ${artisanName} a accepté votre demande et est en route.`
      );
    }

    // If the status changed to COMPLETED, thank the client
    if (updateInterventionDto.status === 'COMPLETED' && updatedIntervention.client.phone) {
      await this.notifications.sendSms(
        updatedIntervention.client.phone,
        `Votre intervention est terminée. Merci d'avoir utilisé Smart Dépannage!`
      );
    }

    return updatedIntervention;
  }
}