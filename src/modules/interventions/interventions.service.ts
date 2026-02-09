import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateInterventionDto } from './dto/create-intervention.dto';
import { UpdateInterventionDto } from './dto/update-intervention.dto';
import { InterventionsGateway } from './interventions.gateway'; 
import { NotificationsService } from '../notifications/notifications.service';
import * as argon2 from 'argon2';

// ⚠️ Import 'Role' from your custom generated path
// Adjust the path if necessary (e.g. '../../../generated/prisma/client')
import { Role } from '../../../generated/prisma/client';

@Injectable()
export class InterventionsService {
  constructor(
    private prisma: PrismaService,
    private gateway: InterventionsGateway,
    private notifications: NotificationsService,
  ) {}

  // ==========================================================
  // 1. CREATE REQUEST (Handles Logged-in Users AND Guests)
  // ==========================================================
  async create(userId: number | null, createInterventionDto: CreateInterventionDto) {
    let finalClientId = userId;

    // A. GUEST LOGIC: If no userId is provided, find or create the user via phone
    if (!finalClientId) {
      const { contactPhone, contactName } = createInterventionDto;

      if (!contactPhone) {
        throw new Error('Phone number is required for guest requests.');
      }

      // 1. Check if a user with this phone already exists
      let user = await this.prisma.user.findFirst({
        where: { phone: contactPhone },
      });

      // 2. If not, create a new "Guest Client" automatically
      if (!user) {
        const dummyPassword = await argon2.hash('123456'); // Default password
        user = await this.prisma.user.create({
          data: {
            // Generate a unique dummy email
            email: `guest_${Date.now()}@smart-depannage.com`,
            phone: contactPhone,
            name: contactName || 'Client Invité',
            password: dummyPassword,
            role: Role.CLIENT,
          },
        });
      }
      
      finalClientId = user.id;
    }

    // B. CLEAN DATA: Remove 'contactName'/'contactPhone' from DTO 
    // because they don't exist on the Intervention table
    const { contactName, contactPhone, ...interventionData } = createInterventionDto;

    // C. SAVE TO DATABASE
    const newIntervention = await this.prisma.intervention.create({
      data: {
        ...interventionData, // description, address, serviceType
        client: {
          connect: { id: finalClientId },
        },
        status: 'PENDING',
      },
      include: {
        client: { select: { id: true, name: true, phone: true } },
      },
    });

    // D. 🔔 Real-Time Notification (WebSockets)
    this.gateway.server.emit('newIntervention', newIntervention);

    // E. 📱 SMS Notification to Admin
    await this.notifications.sendSms(
      '+21600000000', 
      `Alerte: Nouvelle demande (${newIntervention.serviceType}) à ${newIntervention.address}`
    );

    return newIntervention;
  }

  // ==========================================================
  // 2. FIND ALL (Admins)
  // ==========================================================
  async findAll() {
    return this.prisma.intervention.findMany({
      include: {
        client: { select: { id: true, name: true, email: true, phone: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ==========================================================
  // 3. FIND MY REQUESTS (Clients)
  // ==========================================================
  async findByUser(userId: number) {
    return this.prisma.intervention.findMany({
      where: { clientId: userId },
      include: {
        artisan: { select: { name: true, phone: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ==========================================================
  // 4. FIND AVAILABLE JOBS (Artisans)
  // ==========================================================
  async findAllPending() {
    return this.prisma.intervention.findMany({
      where: { status: 'PENDING' },
      include: {
        client: { select: { name: true } }, // Removed address (it's on the intervention)
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ==========================================================
  // 5. FIND SINGLE REQUEST
  // ==========================================================
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

  // ==========================================================
  // 6. UPDATE STATUS (Accept / Complete)
  // ==========================================================
  async update(id: number, updateInterventionDto: UpdateInterventionDto) {
    const updatedIntervention = await this.prisma.intervention.update({
      where: { id },
      data: updateInterventionDto,
      include: {
        client: { select: { id: true, name: true, phone: true } },
        artisan: { select: { id: true, name: true, phone: true } },
      },
    });

    // A. 🔔 Real-Time Notification to Client
    this.gateway.server.emit(`interventionStatus-${id}`, updatedIntervention);

    // B. 📱 SMS Notification logic
    if (updateInterventionDto.status === 'ACCEPTED' && updatedIntervention.client.phone) {
      const artisanName = updatedIntervention.artisan?.name || 'Un artisan';
      await this.notifications.sendSms(
        updatedIntervention.client.phone,
        `Bonne nouvelle! ${artisanName} a accepté votre demande et est en route.`
      );
    }

    if (updateInterventionDto.status === 'COMPLETED' && updatedIntervention.client.phone) {
      await this.notifications.sendSms(
        updatedIntervention.client.phone,
        `Votre intervention est terminée. Merci d'avoir utilisé Smart Dépannage!`
      );
    }

    return updatedIntervention;
  }
}