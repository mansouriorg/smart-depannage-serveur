import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateInterventionDto } from './dto/create-intervention.dto';
import { InterventionsGateway } from './interventions.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { StaffAlertsService } from './staff-alerts.service';
import { ProofsService } from '../proofs/proofs.service';
import { describeError } from '../notifications/delivery/delivery-error';
import * as crypto from 'crypto';

import { Role, Status } from '../../../generated/prisma/client';
import { isTicketStaff } from '../../common/auth/role-policy';
import { withoutStaffFields } from './intervention-redaction';
import { interventionForClient } from '../../common/views/views';
import { initialStatus, statusesInGroup } from '../intervention-workflow/intervention-status';

@Injectable()
export class InterventionsService {
  private readonly logger = new Logger(InterventionsService.name);

  constructor(
    private prisma: PrismaService,
    private gateway: InterventionsGateway,
    private notifications: NotificationsService,
    private staffAlerts: StaffAlertsService,
    private proofs: ProofsService,
  ) {}

  // ==========================================================
  // 1. CREATE REQUEST (a signed-in account)
  // ==========================================================
  async create(userId: number, createInterventionDto: CreateInterventionDto, viewerRole?: string | null) {
    // The three fields of the bot check and the contact fields of a request without account are not columns of a request
    // made by a signed-in account (P1-16).
    const {
      contactName: _contactName,
      contactPhone: _contactPhone,
      photos: sentPhotos,
      botChallenge: _botChallenge,
      botSolution: _botSolution,
      website: _website,
      ...interventionData
    } = createInterventionDto;

    const photos = sentPhotos;

    // Generate the tracking token
    const rawToken = crypto.randomBytes(32).toString('hex');
    const trackingTokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    // Create the intervention
    const newIntervention = await this.prisma.intervention.create({
      data: {
        ...interventionData,
        ...(photos ? { photos } : {}),
        client: {
          connect: { id: userId },
        },
        trackingToken: trackingTokenHash, // Store only the hash
        status: initialStatus() as Status,
      },
      include: {
        client: { select: { id: true, name: true, phone: true } },
      },
    });

    // The back office hears about it: live event, staff notifications and, when
    // ADMIN_ALERT_PHONE is set, a text (capped per hour). Same code for every way of
    // making a request (StaffAlertsService); it never throws.
    await this.staffAlerts.newRequest(newIntervention);

    // Return the raw token ONLY ONCE.
    // Somebody of the back office who files a request through this route reads the row as it is.
    if (isTicketStaff(viewerRole)) {
      return { ...newIntervention, rawTrackingToken: rawToken };
    }

    return { ...interventionForClient(newIntervention), rawTrackingToken: rawToken };
  }

  // ==========================================================
  // 2. FIND MY ASSIGNED MISSIONS (Artisans) 👷‍♂️
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
  // 3. 📸 SECURE WORK COMPLETION (Tamper-Proof Photo Upload)
  // ==========================================================
  /**
   * The artisan closes the job with the "after" photo. The photo is not trusted: it goes through
   * the proof service (P1-07), which judges it on what the server knows (where the job is, how
   * sure the phone is of its position, whether it says the position was simulated, whether the
   * photo was used before), stamps the time itself, keeps the picture behind the login and closes
   * the job in the same transaction. A photo that fails is refused with the reason in words, and
   * the job stays in progress.
   */
  async completeWork(
    id: number,
    artisan: { id: number; role: Role },
    upload: { file: Express.Multer.File | undefined; capture: Record<string, unknown> },
  ) {
    const include = {
      client: { select: { id: true, name: true, phone: true } },
    };

    const result = await this.proofs.submit({
      interventionId: id,
      kind: 'AFTER',
      actor: artisan,
      file: upload.file,
      capture: upload.capture,
      completeJob: true,
      include,
    });

    if (!result.completed) {
      // The same photo sent again after a reply that got lost: the job is closed already.
      throw new ConflictException('Cette mission est déjà clôturée.');
    }

    const updatedIntervention = result.intervention;

    // The job is closed and the proof is kept: a live event or a text message that fails must not
    // turn that into an error (the artisan would send the photo again and be told "already closed").

    // 3. 🔔 Real-Time Notification to Admin/Client
    try {
      this.gateway.sendInterventionStatus(updatedIntervention);
    } catch (error) {
      this.logger.error(`After a job was closed, the live event failed (${describeError(error)}).`);
    }

    // 4. 📱 SMS Notification to Client
    if (updatedIntervention.client?.phone) {
      try {
        await this.notifications.sendSms(
          updatedIntervention.client.phone,
          `Smart Dépannage: Votre intervention est terminée ! Une preuve sécurisée a été enregistrée sur votre dossier.`
        );
      } catch (error) {
        this.logger.error(`After a job was closed, the text message to the client failed (${describeError(error)}).`);
      }
    }

    return { ...withoutStaffFields(updatedIntervention), proof: result.view };
  }

  // ==========================================================
  // 4. 📊 STATISTIQUES DU DASHBOARD (Admin)
  // ==========================================================
  async getDashboardStats() {
    // 1. Calculs optimisés (ne retourne qu'un chiffre, très rapide)
    const total = await this.prisma.intervention.count();
    
    const pending = await this.prisma.intervention.count({ 
      where: { status: { in: statusesInGroup('waiting') as Status[] } } 
    });
    
    const active = await this.prisma.intervention.count({ 
      where: { status: { in: statusesInGroup('active') as Status[] } } 
    });
    
    const completed = await this.prisma.intervention.count({ 
      where: { status: { in: statusesInGroup('completed') as Status[] } } 
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
