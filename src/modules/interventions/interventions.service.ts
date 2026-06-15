import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateInterventionDto } from './dto/create-intervention.dto';
import { UpdateInterventionDto } from './dto/update-intervention.dto';
import { SubmitFeedbackDto } from './dto/submit-feedback.dto'; // ✅ NEW: Import feedback DTO
import { InterventionsGateway } from './interventions.gateway'; 
import { NotificationsService } from '../notifications/notifications.service';
import * as argon2 from 'argon2';
import * as crypto from 'crypto'; // ✅ NEW: Native Node crypto for secure tokens

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

    // B. 🔒 NEW: Generate Tracking Token
    const rawToken = crypto.randomBytes(32).toString('hex');
    const trackingTokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    // C. Create Intervention
    const newIntervention = await this.prisma.intervention.create({
      data: {
        ...interventionData,
        client: {
          connect: { id: finalClientId },
        },
        trackingToken: trackingTokenHash, // Store only the hash
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

    // F. ✅ NEW: Return the raw token ONLY ONCE so the controller can set the cookie
    return { ...newIntervention, rawTrackingToken: rawToken };
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
          } 
        },
      },
      orderBy: { createdAt: 'desc' }, // Show newest missions first
    });
  }

  // ==========================================================
  // 8. 📸 SECURE WORK COMPLETION (Tamper-Proof Photo Upload)
  // ==========================================================
  async completeWork(
    id: number, 
    proofData: { photoUrl: string; latitude: number; longitude: number; timestamp: Date }
  ) {
    // 1. Verify intervention exists
    const intervention = await this.prisma.intervention.findUnique({ where: { id } });
    if (!intervention) {
      throw new NotFoundException(`Intervention #${id} introuvable.`);
    }

    // 2. Update database with "After" photo metadata and update status
    const updatedIntervention = await this.prisma.intervention.update({
      where: { id },
      data: {
        status: 'COMPLETED',
        afterPhotoUrl: proofData.photoUrl,
        afterPhotoLat: proofData.latitude,
        afterPhotoLng: proofData.longitude,
        afterPhotoAt: proofData.timestamp,
      },
      include: {
        client: { select: { id: true, name: true, phone: true } },
      },
    });

    // 3. 🔔 Real-Time Notification to Admin/Client
    this.gateway.server.emit(`interventionStatus-${id}`, updatedIntervention);

    // 4. 📱 SMS Notification to Client
    if (updatedIntervention.client?.phone) {
      await this.notifications.sendSms(
        updatedIntervention.client.phone,
        `Smart Dépannage: Votre intervention est terminée ! Une preuve sécurisée a été enregistrée sur votre dossier.`
      );
    }

    return updatedIntervention;
  }

  // ==========================================================
  // 9. 🔐 SECURE PUBLIC TRACKING (Next.js Link)
  // ==========================================================
  async findByTrackingToken(id: number, rawToken: string) {
    // Re-hash the raw token provided by the cookie
    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');
    
    const intervention = await this.prisma.intervention.findFirst({
      where: { 
        id, 
        trackingToken: hashedToken 
      },
      include: {
        artisan: {
          select: { name: true, phone: true } // Expose safe data only
        }
      }
    });

    if (!intervention) {
      throw new NotFoundException("Demande introuvable ou token invalide");
    }

    return intervention;
  }

  // ==========================================================
  // 10. ⭐ SUBMIT FEEDBACK (Client)
  // ==========================================================
  async submitFeedback(id: number, rawToken: string, dto: SubmitFeedbackDto) {
    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');

    // Verify token matches AND the job is actually finished
    const intervention = await this.prisma.intervention.findFirst({
      where: { id, trackingToken: hashedToken, status: 'COMPLETED' }
    });

    if (!intervention) {
      throw new NotFoundException("Action impossible ou demande introuvable");
    }

    return this.prisma.intervention.update({
      where: { id },
      data: {
        rating: dto.rating,
        isOnTime: dto.isOnTime,
        hasIssue: dto.hasIssue ?? false,
        feedbackNotes: dto.feedbackNotes,
      }
    });
  }

  // ==========================================================
  // 11. 🚨 REPORT ISSUE DURING INTERVENTION
  // ==========================================================
  async reportActiveIssue(id: number, rawToken: string, issueDescription: string) {
    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');

    // Ensure the intervention belongs to this token AND is currently active
    const intervention = await this.prisma.intervention.findFirst({
      where: { 
        id, 
        trackingToken: hashedToken, 
        status: { in: ['ACCEPTED', 'IN_PROGRESS'] } // Only allow during these states
      }
    });

    if (!intervention) {
      throw new NotFoundException("Action impossible ou demande introuvable");
    }

    // Append the new issue to any existing feedback notes with a timestamp
    const timestamp = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    const newNote = `[Signalement à ${timestamp}] : ${issueDescription}`;
    const updatedNotes = intervention.feedbackNotes 
      ? `${intervention.feedbackNotes}\n${newNote}` 
      : newNote;

    const updatedIntervention = await this.prisma.intervention.update({
      where: { id },
      data: {
        hasIssue: true, // Flag the issue for the Admin dashboard
        feedbackNotes: updatedNotes,
      }
    });

    // 🔔 Real-Time Notification to Admin
    this.gateway.server.emit('interventionIssue', {
      interventionId: id,
      issue: issueDescription
    });

    return updatedIntervention;
  }
}