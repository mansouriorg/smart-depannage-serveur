import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateInterventionDto } from './dto/create-intervention.dto';
import { UpdateInterventionDto } from './dto/update-intervention.dto';
import { SubmitFeedbackDto } from './dto/submit-feedback.dto'; 
import { InterventionsGateway } from './interventions.gateway'; 
import { NotificationsService } from '../notifications/notifications.service';
import { generateUnusablePassword } from '../auth/password-setup';
import * as argon2 from 'argon2';
import * as crypto from 'crypto'; 

// ⚠️ Import 'Role' from your custom generated path
import { Role, Status } from '../../../generated/prisma/client';
import { isTicketStaff } from '../../common/auth/role-policy';
import { forMarketplace, withoutStaffFields } from './intervention-redaction';

// guest_<timestamp>@smart-depannage.com: guests created by the old public form.
const LEGACY_GUEST_EMAIL = /^guest_\d+@smart-depannage\.com$/;

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

    // A. GUEST LOGIC: no userId means a public request without account.
    //
    // P0-04: this path used to find ANY user by phone (admin, artisan, client)
    // and attach the request to it, and it created accounts with the fixed
    // password "123456". Now:
    //   - an existing real account is never reused: its owner must log in;
    //   - only a previous guest profile (no credentials) is reused;
    //   - a new guest profile gets a random, never-disclosed password.
    if (!finalClientId) {
      const { contactPhone, contactName } = createInterventionDto;

      if (!contactPhone) {
        throw new BadRequestException(
          'Un numéro de téléphone est requis pour une demande sans compte.',
        );
      }

      // Only live accounts count: a deleted or deactivated account must not
      // lock its former owner out of the public form.
      const candidates = await this.prisma.user.findMany({
        where: { phone: contactPhone, deletedAt: null, isActive: true },
        orderBy: { id: 'asc' },
      });

      // Guest profiles created before the `isGuest` flag existed were stored as
      // regular CLIENT users with a generated e-mail and the password
      // "123456". They are still guests, but only while that password is
      // unchanged: someone who chose their own password owns a real account.
      // (scripts/rotate-default-passwords.ts flags them for good.)
      const isGuestProfile = async (user: {
        isGuest: boolean;
        email: string;
        role: Role;
        password: string;
      }) =>
        user.isGuest ||
        (user.role === Role.CLIENT &&
          LEGACY_GUEST_EMAIL.test(user.email) &&
          (await argon2.verify(user.password, '123456').catch(() => false)));

      for (const candidate of candidates) {
        if (!(await isGuestProfile(candidate))) {
          throw new ConflictException(
            'Un compte existe déjà avec ce numéro. Connectez-vous pour envoyer votre demande.',
          );
        }
      }

      const existing = candidates[0];

      const user =
        existing ??
        (await this.prisma.user.create({
          data: {
            email: `guest_${crypto.randomUUID()}@guest.smart-depannage.local`,
            phone: contactPhone,
            name: contactName || 'Client Invité',
            password: await argon2.hash(generateUnusablePassword()),
            role: Role.CLIENT,
            isActive: true,
            isGuest: true,
          },
        }));

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
    this.gateway.sendNewIntervention(newIntervention);

    // E. 📱 SMS Notification to Admin
    await this.notifications.sendSms(
      '+21600000000', 
      `Alerte: Nouvelle demande (${newIntervention.serviceType}) à ${newIntervention.address}`
    );

    // F. ✅ NEW: Return the raw token ONLY ONCE so the controller can set the cookie
    //
    // An anonymous caller only gets the request back, not the profile it was
    // attached to: with an existing guest profile that would answer "whose
    // phone number is this?".
    if (!userId) {
      const { client: _client, ...publicIntervention } = newIntervention;

      return { ...publicIntervention, rawTrackingToken: rawToken };
    }

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
    const rows = await this.prisma.intervention.findMany({
      where: { clientId: userId },
      include: {
        artisan: { select: { name: true, phone: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return rows.map((row) => withoutStaffFields(row));
  }

  // ==========================================================
  // 4. FIND AVAILABLE JOBS (For Market Place / Job Board)
  // ==========================================================
  async findAllPending() {
    const rows = await this.prisma.intervention.findMany({
      where: { status: 'PENDING' },
      include: {
        client: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Open jobs are visible to every artisan: no staff data, no way to reach
    // the client before the job is assigned.
    return rows.map((row) => forMarketplace(row));
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
  // 5b. FIND SINGLE REQUEST — ACCESS CONTROLLED (P0-16)
  // Before, any logged-in user could read any ticket (client name and phone
  // included) just by changing the id in the URL.
  //   staff   : every ticket
  //   client  : their own tickets
  //   artisan : tickets assigned to them, or a still unassigned PENDING one
  //             (marketplace), without the client's phone number
  // Anything else answers 404, so the id space cannot be probed.
  // ==========================================================
  async findOneForActor(id: number, actor: { id: number; role: Role }) {
    const intervention = await this.findOne(id);

    if (isTicketStaff(actor.role)) {
      return intervention;
    }

    if (actor.role === Role.CLIENT && intervention.clientId === actor.id) {
      return withoutStaffFields(intervention);
    }

    if (actor.role === Role.ARTISAN) {
      if (intervention.artisanId === actor.id) {
        return withoutStaffFields(intervention);
      }

      if (intervention.artisanId === null && intervention.status === Status.PENDING) {
        return {
          ...forMarketplace(intervention),
          client: intervention.client
            ? { id: intervention.client.id, name: intervention.client.name }
            : intervention.client,
        };
      }
    }

    throw new NotFoundException(`Intervention #${id} not found`);
  }

  // ==========================================================
  // 6b. UPDATE BY AN ARTISAN (P0-16)
  // An artisan may only move THEIR OWN ticket forward on the road to the job.
  // Assigning, completing and every other field stay with staff
  // (completion goes through the proof-of-work upload).
  // ==========================================================
  private static readonly ARTISAN_ALLOWED_STATUSES: Status[] = [
    Status.ON_THE_WAY,
    Status.ARRIVED,
    Status.ARTISAN_ON_THE_WAY,
    Status.ARTISAN_ARRIVED,
    Status.IN_PROGRESS,
  ];

  // The artisan cannot move a ticket out of these: the quote, the payment and
  // the dispute steps belong to the client and the back office. The complete
  // transition table replaces this list in P1-01.
  private static readonly ARTISAN_LOCKED_STATUSES: Status[] = [
    Status.COMPLETED,
    Status.CANCELLED,
    Status.QUOTE_SENT,
    Status.WAITING_CLIENT_VALIDATION,
    Status.PAYMENT_PENDING,
    Status.PAID,
    Status.INVOICE_READY,
    Status.INVOICE_SENT,
    Status.DISPUTED,
  ];

  async updateAsArtisan(
    id: number,
    artisanId: number,
    dto: UpdateInterventionDto,
  ) {
    const intervention = await this.prisma.intervention.findUnique({
      where: { id },
      select: { artisanId: true, status: true },
    });

    if (!intervention || intervention.artisanId !== artisanId) {
      throw new NotFoundException(`Intervention #${id} not found`);
    }

    const requestedFields = Object.keys(dto).filter(
      (key) => (dto as Record<string, unknown>)[key] !== undefined,
    );

    if (
      requestedFields.length !== 1 ||
      requestedFields[0] !== 'status' ||
      !dto.status ||
      !InterventionsService.ARTISAN_ALLOWED_STATUSES.includes(dto.status)
    ) {
      throw new ForbiddenException(
        'Un artisan ne peut changer que le statut de sa propre mission (en route, sur place, en cours).',
      );
    }

    if (InterventionsService.ARTISAN_LOCKED_STATUSES.includes(intervention.status)) {
      throw new BadRequestException(
        "Cette mission ne peut plus être modifiée depuis l'application (clôturée, devis, paiement ou litige en cours).",
      );
    }

    return this.update(id, { status: dto.status });
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
    this.gateway.sendInterventionStatus(updatedIntervention);

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
    const rows = await this.prisma.intervention.findMany({
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

    return rows.map((row) => withoutStaffFields(row));
  }

  // ==========================================================
  // 8. 📸 SECURE WORK COMPLETION (Tamper-Proof Photo Upload)
  // ==========================================================
  async completeWork(
    id: number, 
    artisanId: number,
    proofData: { photoUrl: string; latitude: number; longitude: number; timestamp: Date }
  ) {
    // 1. Verify intervention exists AND is assigned to the artisan who calls (P0-16).
    // Before, any artisan could complete any ticket.
    const intervention = await this.prisma.intervention.findUnique({ where: { id } });
    if (!intervention || intervention.artisanId !== artisanId) {
      throw new NotFoundException(`Intervention #${id} introuvable.`);
    }

    // Same lock as updateAsArtisan: proof of work cannot skip the quote, the
    // payment or the dispute steps.
    if (InterventionsService.ARTISAN_LOCKED_STATUSES.includes(intervention.status)) {
      throw new BadRequestException(
        "Cette mission ne peut plus être clôturée depuis l'application (déjà clôturée, devis, paiement ou litige en cours).",
      );
    }

    if (
      !Number.isFinite(proofData.latitude) ||
      !Number.isFinite(proofData.longitude) ||
      Number.isNaN(proofData.timestamp.getTime())
    ) {
      throw new BadRequestException(
        'Position GPS et horodatage valides obligatoires pour la preuve.',
      );
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
    this.gateway.sendInterventionStatus(updatedIntervention);

    // 4. 📱 SMS Notification to Client
    if (updatedIntervention.client?.phone) {
      await this.notifications.sendSms(
        updatedIntervention.client.phone,
        `Smart Dépannage: Votre intervention est terminée ! Une preuve sécurisée a été enregistrée sur votre dossier.`
      );
    }

    return withoutStaffFields(updatedIntervention);
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

    // The link holder is the customer: no staff notes, no token hash.
    return withoutStaffFields(intervention);
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
    this.gateway.sendInterventionIssue({
      interventionId: id,
      issue: issueDescription
    });

    return updatedIntervention;
  }

  // ==========================================================
  // 12. 📊 STATISTIQUES DU DASHBOARD (Admin)
  // ==========================================================
  async getDashboardStats() {
    // 1. Calculs optimisés (ne retourne qu'un chiffre, très rapide)
    const total = await this.prisma.intervention.count();
    
    const pending = await this.prisma.intervention.count({ 
      where: { status: 'PENDING' } 
    });
    
    const active = await this.prisma.intervention.count({ 
      where: { status: { in: ['ACCEPTED', 'IN_PROGRESS'] } } 
    });
    
    const completed = await this.prisma.intervention.count({ 
      where: { status: 'COMPLETED' } 
    });

    const resolutionRate = total > 0 ? Math.round((completed / total) * 100) : 0;

    // 2. Récupérer uniquement les 4 interventions les plus récentes
    const recentActivity = await this.prisma.intervention.findMany({
      take: 4,
      orderBy: { createdAt: 'desc' },
      include: {
        client: { select: { name: true, phone: true } },
        artisan: { select: { name: true, phone: true } },
      }
    });

    // 3. Retourner l'objet formaté
    return {
      kpis: {
        total,
        pending,
        active,
        completed,
        resolutionRate
      },
      recentActivity
    };
  }
}
