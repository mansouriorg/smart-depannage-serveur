import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateInterventionDto } from './dto/create-intervention.dto';
import { UpdateInterventionDto } from './dto/update-intervention.dto';
import { InterventionsGateway } from './interventions.gateway'; 
import { NotificationsService } from '../notifications/notifications.service';
import * as argon2 from 'argon2';

// ⚠️ Import 'Role' from your custom generated path
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

    const { contactName, contactPhone, ...interventionData } = createInterventionDto;

    const newIntervention = await this.prisma.intervention.create({
      data: {
        ...interventionData,
        client: {
          connect: { id: finalClientId },
        },
        status: 'PENDING',
      },
      include: {
        client: { select: { id: true, name: true, phone: true } },
      },
    });

    // D. 🔔 Real-Time Notification
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
        artisan: { select: { id: true, name: true, phone: true } }, // Included artisan info
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
  // 4. FIND AVAILABLE JOBS (For Market Place / Job Board)
  // ==========================================================
  async findAllPending() {
    return this.prisma.intervention.findMany({
      where: { status: 'PENDING' },
      include: {
        client: { select: { name: true } },
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
  // 6. UPDATE (Assign Artisan / Change Status)
  // ==========================================================
  async update(id: number, updateInterventionDto: UpdateInterventionDto) {
    // 1. Separate artisanId from the rest of the data
    const { artisanId, ...rest } = updateInterventionDto;
    
    // 2. Prepare the object for Prisma
    const dataToUpdate: any = { ...rest };

    // 🛠️ LOGIC: If we are assigning an Artisan
    if (artisanId) {
      // Connect the relation to the User table
      dataToUpdate.artisan = { connect: { id: artisanId } };
      
      // Auto-set status to ACCEPTED if not specified
      if (!dataToUpdate.status) {
        dataToUpdate.status = 'ACCEPTED';
      }
    }

    // 3. Save to Database
    const updatedIntervention = await this.prisma.intervention.update({
      where: { id },
      data: dataToUpdate,
      include: {
        client: { select: { id: true, name: true, phone: true } },
        artisan: { select: { id: true, name: true, phone: true } },
      },
    });

    // 4. 🔔 Real-Time Notification
    this.gateway.server.emit(`interventionStatus-${id}`, updatedIntervention);

    // 5. 📱 SMS Notification Logic
    
    // Case A: Client Notification (Accepted)
    if (updatedIntervention.status === 'ACCEPTED' && updatedIntervention.client.phone) {
      const artisanName = updatedIntervention.artisan?.name || 'Un artisan';
      await this.notifications.sendSms(
        updatedIntervention.client.phone,
        `Smart Dépannage: Votre demande a été acceptée ! ${artisanName} prend en charge votre dossier.`
      );
    }

    // Case B: Client Notification (Completed)
    if (updatedIntervention.status === 'COMPLETED' && updatedIntervention.client.phone) {
      await this.notifications.sendSms(
        updatedIntervention.client.phone,
        `Intervention terminée. Merci de votre confiance !`
      );
    }

    // Case C: Artisan Notification (New Assignment)
    if (artisanId && updatedIntervention.artisan?.phone) {
      await this.notifications.sendSms(
        updatedIntervention.artisan.phone,
        `Nouveau Chantier: ${updatedIntervention.serviceType} à ${updatedIntervention.address}. Client: ${updatedIntervention.client.name}`
      );
    }

    return updatedIntervention;
  }

  // ==========================================================
  // 7. FIND MY ASSIGNED MISSIONS (Artisans) 👷‍♂️
  // ==========================================================
  // This is the function you needed!
  async findByArtisan(artisanId: number) {
    return this.prisma.intervention.findMany({
      where: { 
        artisanId: artisanId, // ✅ Only get missions assigned to THIS technician
      },
      include: {
        // We include Client info so the Technician sees who to call/visit on his screen
        client: { 
          select: { 
            id: true, 
            name: true, 
            phone: true,
            // Add 'address' here if it is on the User model, otherwise rely on intervention.address
          } 
        },
      },
      orderBy: { createdAt: 'desc' }, // Show newest missions first
    });
  }
}