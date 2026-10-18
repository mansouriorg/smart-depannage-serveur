import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateInterventionDto } from './dto/create-intervention.dto';
import { UpdateInterventionDto } from './dto/update-intervention.dto';
import { SubmitFeedbackDto } from './dto/submit-feedback.dto'; 
import { InterventionsGateway } from './interventions.gateway'; 
import { isMadeUpGuestEmail } from '../notifications/delivery/contact';
import { NotificationsService } from '../notifications/notifications.service';
import { generateUnusablePassword } from '../auth/password-setup';
import { StaffAlertsService } from './staff-alerts.service';
import { AssignmentService } from '../assignment/assignment.service';
import { MissionActionsService } from '../mission-actions/mission-actions.service';
import { ProofsService } from '../proofs/proofs.service';
import { describeError } from '../notifications/delivery/delivery-error';
import * as argon2 from 'argon2';
import * as crypto from 'crypto'; 

// ⚠️ Import 'Role' from your custom generated path
import { Role, Status } from '../../../generated/prisma/client';
import { isTicketStaff } from '../../common/auth/role-policy';
import { forMarketplace, withoutStaffFields } from './intervention-redaction';
import { interventionForClient, interventionForTracking } from '../../common/views/views';
import {
  StatusActor,
  canonicalStatus,
  initialStatus,
  statusesInGroup,
  withAliases,
} from '../intervention-workflow/intervention-status';
import { transitionStatusDetailed } from '../intervention-workflow/transition-status';
import {
  isUniqueViolation,
  phoneColumns,
  phoneWhere,
  rethrowContactConflict,
} from '../../common/contact/phone';

import { MAX_ISSUE_NOTES_LENGTH, notesAfterReview } from './feedback-notes';

/** Most characters the notes of a request may reach through the public "report an issue" route. */
export { MAX_ISSUE_NOTES_LENGTH };

// guest_<timestamp>@smart-depannage.com: guests created by the old public form.
const LEGACY_GUEST_EMAIL = /^guest_\d+@smart-depannage\.com$/;

@Injectable()
export class InterventionsService {
  private readonly logger = new Logger(InterventionsService.name);

  constructor(
    private prisma: PrismaService,
    private gateway: InterventionsGateway,
    private notifications: NotificationsService,
    private staffAlerts: StaffAlertsService,
    private assignment: AssignmentService,
    private missionActions: MissionActionsService,
    private proofs: ProofsService,
  ) {}

  // ==========================================================
  // 1. CREATE REQUEST (Handles Logged-in Users AND Guests)
  // ==========================================================
  async create(userId: number | null, createInterventionDto: CreateInterventionDto, viewerRole?: string | null) {
    let finalClientId = userId;

    // A. GUEST LOGIC: no userId means a public request without account.
    //
    // P0-04: this path used to find ANY user by phone (admin, artisan, client)
    // and attach the request to it, and it created accounts with the fixed
    // password "123456". Now:
    //   - an existing real account is never reused: its owner must log in;
    //   - only a previous guest profile (no credentials) is reused;
    //   - a new guest profile gets a random, never-disclosed password.
    let guestRequest = false;
    let guestWithoutNumber = false;

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
        where: { ...phoneWhere(contactPhone), deletedAt: null, isActive: true },
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

      // A profile is reused only when no mailbox is behind it (a made-up address). One that
      // has a real address was made by somebody who typed it next to this number on a form:
      // attaching this request to it could send the notices to that person. Such a number
      // counts as taken below and the profile made here goes without it.
      const existing = candidates.find((candidate) => isMadeUpGuestEmail(candidate.email));

      // A number belongs to one account: if a deleted or deactivated account
      // still holds it, the guest profile is made without the number.
      const numberTaken =
        !existing && (await this.prisma.user.count({ where: phoneWhere(contactPhone) })) > 0;

      const newProfile = async (withNumber: boolean) =>
        this.prisma.user.create({
          data: {
            email: `guest_${crypto.randomUUID()}@guest.smart-depannage.local`,
            ...(withNumber ? phoneColumns(contactPhone) : { phone: null, phoneKey: null }),
            name: contactName || 'Client Invité',
            password: await argon2.hash(generateUnusablePassword()),
            role: Role.CLIENT,
            isActive: true,
            isGuest: true,
          },
        });

      const user =
        existing ??
        (await newProfile(!numberTaken).catch(async (error) => {
          if (!isUniqueViolation(error)) throw error;

          // The same number was taken at the same moment by another request.
          const winner = await this.prisma.user.findFirst({
            where: { ...phoneWhere(contactPhone), deletedAt: null, isActive: true },
            orderBy: { id: 'asc' },
          });

          if (winner && (await isGuestProfile(winner))) {
            // The same person sending the form twice: use the profile the other request made.
            if (isMadeUpGuestEmail(winner.email)) return winner;

            // A guest with a real address of its own has the number: this one goes without it.
            return newProfile(false);
          }

          return rethrowContactConflict(error);
        }));

      finalClientId = user.id;
      guestRequest = true;
      guestWithoutNumber = !user.phone;
    }

    const { contactName, contactPhone, photos: sentPhotos, ...interventionData } = createInterventionDto;

    // A visitor with no account cannot upload here, so a "photo" they send is only a link
    // they typed, and staff would see it as a photo. Pictures come through
    // POST /guest/interventions/:id/photos. A signed-in client keeps what the app sent.
    const photos = userId ? sentPhotos : undefined;

    // B. 🔒 NEW: Generate Tracking Token
    const rawToken = crypto.randomBytes(32).toString('hex');
    const trackingTokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    // C. Create Intervention
    const newIntervention = await this.prisma.intervention.create({
      data: {
        ...interventionData,
        ...(photos ? { photos } : {}),
        // A guest profile that could not keep the number (a deleted account still holds
        // it) must not lose the way to call this person back: it stays on the request.
        ...(guestRequest && guestWithoutNumber ? { contactPhone, contactName } : {}),
        client: {
          connect: { id: finalClientId },
        },
        trackingToken: trackingTokenHash, // Store only the hash
        status: initialStatus() as Status,
      },
      include: {
        client: { select: { id: true, name: true, phone: true } },
      },
    });

    // D. 🔔 The back office hears about it: live event, staff notifications and, when
    // ADMIN_ALERT_PHONE is set, a text (capped per hour). Same code for every way of
    // making a request (StaffAlertsService); it never throws.
    await this.staffAlerts.newRequest(newIntervention);

    // F. ✅ NEW: Return the raw token ONLY ONCE so the controller can set the cookie
    //
    // An anonymous caller only gets the request back, not the profile it was
    // attached to: with an existing guest profile that would answer "whose
    // phone number is this?".
    if (!userId) {
      return { ...interventionForTracking(newIntervention), rawTrackingToken: rawToken };
    }

    // Somebody of the back office who files a request through this route reads the row as it is.
    if (isTicketStaff(viewerRole)) {
      return { ...newIntervention, rawTrackingToken: rawToken };
    }

    return { ...interventionForClient(newIntervention), rawTrackingToken: rawToken };
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

    return rows.map((row) => interventionForClient(row));
  }

  // ==========================================================
  // 4. FIND AVAILABLE JOBS (For Market Place / Job Board)
  // ==========================================================
  async findAllPending(artisanUserId?: number) {
    // A job this artisan refused is not offered to them again (P1-06).
    const profile = artisanUserId
      ? await this.prisma.artisanProfile.findUnique({ where: { userId: artisanUserId }, select: { id: true } })
      : null;

    const rows = await this.prisma.intervention.findMany({
      where: {
        status: { in: withAliases(['CREATED']) as Status[] },
        ...(profile ? { missionRejections: { none: { artisanProfileId: profile.id } } } : {}),
      },
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
      return interventionForClient(intervention);
    }

    if (actor.role === Role.ARTISAN) {
      if (intervention.artisanId === actor.id) {
        return withoutStaffFields(intervention);
      }

      if (intervention.artisanId === null && canonicalStatus(intervention.status) === 'CREATED') {
        // The board's copy: the customer's first name only, no id, no way to call or write.
        return forMarketplace(intervention);
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

    // On the way and arrived are the steps of the mission service (P1-06): the same lock, the
    // same dates, the same line in the timeline, the same messages to the client and the back
    // office as the routes of the artisan app. This route used to change the status alone.
    const target = canonicalStatus(dto.status);

    if (target === 'ARTISAN_ON_THE_WAY' || target === 'ARTISAN_ARRIVED') {
      const step = {
        userId: artisanId,
        interventionId: id,
        include: {
          client: { select: { id: true, name: true, phone: true } },
          artisan: { select: { id: true, name: true, phone: true } },
        },
      };

      const row = await (target === 'ARTISAN_ON_THE_WAY'
        ? this.missionActions.onTheWay(step)
        : this.missionActions.arrived(step));

      // The dashboard that still listens on the first socket gets the change as before (the
      // mission service sends the one of the new socket). The step is made: a socket that
      // fails must not turn it into an error the artisan answers by pressing again.
      try {
        this.gateway.sendInterventionStatus(row);
      } catch (error) {
        this.logger.error(`After a step of an artisan, the live event of the first socket failed (${describeError(error)}).`);
      }

      return row;
    }

    // What the artisan may do from the current status is decided by the status
    // table (intervention-status.ts): a closed, quoted, paid or disputed job
    // is refused there, with a 409 or 403. The answer has no column of the back office.
    return withoutStaffFields(
      await this.update(id, { status: dto.status }, { kind: 'artisan', userId: artisanId }),
    );
  }

  // ==========================================================
  // 6. UPDATE (Assign Artisan / Change Status)
  // ==========================================================
  async update(
    id: number,
    updateInterventionDto: UpdateInterventionDto,
    actor: StatusActor = { kind: 'staff' },
  ) {
    // 1. Separate the status and the artisan from the rest of the data
    const { artisanId, status, ...rest } = updateInterventionDto;

    const include = {
      client: { select: { id: true, name: true, phone: true } },
      artisan: { select: { id: true, name: true, phone: true } },
    };

    // Giving a job to an artisan is the one assignment path (P1-05): the artisan must
    // be approved and free, the job in a status that can be assigned, and the status,
    // the artisan and the appointment change together. Nothing else rides along: the
    // check is about that artisan and that job, not about a title or a photo.
    if (artisanId) {
      if (actor.kind !== 'staff' || !actor.userId) {
        throw new ForbiddenException('Seule l’administration peut assigner un artisan.');
      }

      // The dropdown has always put the job on "accepted" (what the mobile app and the
      // dashboard show as "affecté"); the same statuses are still the only ones allowed.
      const landing = status === undefined ? Status.ARTISAN_ACCEPTED : canonicalStatus(status);

      if (landing !== 'ASSIGNED' && landing !== 'ARTISAN_ACCEPTED') {
        throw new BadRequestException(
          'Pour confier la mission à un artisan, le statut ne peut être que « assignée » ou « acceptée ».',
        );
      }

      if (Object.values(rest).some((value) => value !== undefined)) {
        throw new BadRequestException(
          'Assignez l’artisan dans une requête séparée des autres modifications.',
        );
      }

      const { intervention } = await this.assignment.assign({
        interventionId: id,
        artisanId,
        actorId: actor.userId,
        status: landing,
        include,
      });

      // Live event for the dashboards; the artisan and the client are told by the assignment.
      this.gateway.sendInterventionStatus(intervention);

      return intervention;
    }

    // 2. Prepare the columns for Prisma
    const data: Record<string, unknown> = { ...rest };

    const target = status;

    // 3. Save to Database. A status change goes through the status table.
    let statusChanged = false;
    let updatedIntervention: any;

    if (target) {
      const result = await transitionStatusDetailed(this.prisma, {
        id,
        to: target,
        actor,
        data,
        include,
      });

      updatedIntervention = result.row;
      statusChanged = result.changed;
    } else {
      updatedIntervention = await this.prisma.intervention.update({
        where: { id },
        data: data as any,
        include,
      });
    }

    // 4. 🔔 Real-Time Notification
    this.gateway.sendInterventionStatus(updatedIntervention);

    // 5. 📱 SMS Notification Logic

    // Case A: Client Notification (the artisan accepted)
    if (statusChanged && canonicalStatus(updatedIntervention.status) === 'ARTISAN_ACCEPTED' && updatedIntervention.client.phone) {
      const artisanName = updatedIntervention.artisan?.name || 'Un artisan';
      await this.notifications.sendSms(
        updatedIntervention.client.phone,
        `Smart Dépannage: Votre demande a été acceptée ! ${artisanName} prend en charge votre dossier.`
      );
    }

    // Case B: Client Notification (Completed)
    if (statusChanged && updatedIntervention.status === 'COMPLETED' && updatedIntervention.client.phone) {
      await this.notifications.sendSms(
        updatedIntervention.client.phone,
        `Intervention terminée. Merci de votre confiance !`
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

    // The link holder is the customer without an account: their request, no staff notes, no token
    // hash, no id of anybody.
    return interventionForTracking(intervention);
  }

  // ==========================================================
  // 10. ⭐ SUBMIT FEEDBACK (Client)
  // ==========================================================
  async submitFeedback(id: number, rawToken: string, dto: SubmitFeedbackDto) {
    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');

    // Verify token matches AND the job is actually finished (completed, being
    // paid or invoiced: the customer can still rate it after the payment).
    const intervention = await this.prisma.intervention.findFirst({
      where: {
        id,
        trackingToken: hashedToken,
        status: { in: statusesInGroup('completed') as Status[] },
      },
    });

    if (!intervention) {
      throw new NotFoundException("Action impossible ou demande introuvable");
    }

    const reviewed = await this.prisma.intervention.update({
      where: { id },
      data: {
        rating: dto.rating,
        isOnTime: dto.isOnTime,
        // A form that posts every field must not wipe a problem that was reported.
        hasIssue: dto.hasIssue ?? intervention.hasIssue ?? false,
        feedbackNotes: notesAfterReview(
          intervention.feedbackNotes,
          dto.feedbackNotes,
          Boolean(intervention.hasIssue),
        ),
      }
    });

    return interventionForTracking(reviewed);
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
        status: { in: withAliases(['ARTISAN_ACCEPTED', 'ARTISAN_ON_THE_WAY', 'ARTISAN_ARRIVED', 'IN_PROGRESS']) as Status[] } // Only allow while the artisan is on the job
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

    // The notes grow with every report and this route is public: past a few thousand
    // characters, the support staff already have more than they can read. The limit
    // is on the row itself, so it holds whatever the address or the server restarts.
    if (updatedNotes.length > MAX_ISSUE_NOTES_LENGTH) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          message: 'Vous avez déjà signalé plusieurs problèmes sur cette demande. Contactez le support.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

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

    return interventionForTracking(updatedIntervention);
  }

  // ==========================================================
  // 12. 📊 STATISTIQUES DU DASHBOARD (Admin)
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
