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

import * as argon2 from 'argon2';
import * as crypto from 'crypto';

import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { getFrontendUrl as getConfiguredFrontendUrl } from '../../config/env';
import {
  canonicalEmail,
  RATE_RULES,
  RateLimitService,
} from '../../common/rate-limit/rate-limit.service';
import {
  isUniqueViolation,
  phoneColumns,
  phoneKeyOf,
  phoneWhere,
  rethrowContactConflict,
} from '../../common/contact/phone';
import {
  generateLinkToken,
  generateSixDigitCode,
  hashLinkToken,
  hashOneTimeCode,
} from '../../common/auth/one-time-code';
import { isDeliverableEmail, isMadeUpGuestEmail } from '../notifications/delivery/contact';
import { describeError } from '../notifications/delivery/delivery-error';
import { InterventionEventsService } from '../intervention-events/intervention-events.service';
import { StaffAlertsService } from '../interventions/staff-alerts.service';
import {
  interventionForTracking,
  paymentForClient,
  quoteForParties,
  quotesForParties,
} from '../../common/views/views';
import { FilesService } from '../files/files.service';
import { ComplaintsService } from '../complaints/complaints.service';
import { buildTrackingUrl } from '../../common/links/tracking-url';
import { checkRequestedService } from '../service-catalog/catalog-check';
import { notesAfterReview } from '../interventions/feedback-notes';
import { greetingName } from './greeting-name';
import { KeyedLock } from '../../common/concurrency/limits';
import { initialStatus, statusesInGroup } from '../intervention-workflow/intervention-status';
import { transitionStatus } from '../intervention-workflow/transition-status';

import { CreateGuestInterventionDto } from './dto/create-guest-intervention.dto';
import { GuestQuoteActionDto } from './dto/guest-quote-action.dto';
import { GuestPaymentDto } from './dto/guest-payment.dto';
import { GuestFeedbackDto } from './dto/guest-feedback.dto';
import { GuestProblemReportDto } from './dto/guest-problem-report.dto';
import { RequestGuestActivationDto } from './dto/request-guest-activation.dto';
import { ActivateGuestAccountDto } from './dto/activate-guest-account.dto';

import {
  AuthTokenType,
  InterventionEventType,
  PaymentMethod,
  PaymentStatus,
  QuoteStatus,
  ReviewModerationStatus,
  Role,
  Status,
  UrgencyLevel,
  User,
} from '../../../generated/prisma/client';

/**
 * True when a guest profile agrees with everything a request form says: its number
 * (if it has one) is the number on the form, and its address is either made up (no
 * mailbox behind it) or the address on the form.
 */
function guestAgreesWithForm(
  guest: { email: string; phone: string | null; phoneKey: string | null },
  form: { email?: string | null; phoneKey: string | null },
): boolean {
  const guestKey = guest.phoneKey ?? phoneKeyOf(guest.phone);

  if (guestKey && guestKey !== form.phoneKey) return false;

  return isMadeUpGuestEmail(guest.email) || Boolean(form.email && guest.email === form.email);
}

const ALREADY_REVIEWED = 'Vous avez déjà donné votre avis sur cette intervention.';

@Injectable()
export class GuestService {
  private readonly logger = new Logger(GuestService.name);

  /** Photos of one request are added one call at a time (the cap is read, then used). */
  private readonly photoLock = new KeyedLock();

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly events: InterventionEventsService,
    private readonly rateLimit: RateLimitService,
    private readonly staffAlerts: StaffAlertsService,
    private readonly files: FilesService,
    private readonly complaints: ComplaintsService,
  ) {}

  // ==========================================================
  // 1. HELPERS
  // ==========================================================

  private getFrontendUrl(): string {
    return getConfiguredFrontendUrl();
  }

  private hashToken(token: string): string {
    // A link that was not sent at all hashes like an empty one, which no job has: "not found", not a crash (P1-17).
    return crypto.createHash('sha256').update(String(token ?? '')).digest('hex');
  }

  private generateRawToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  private generateUnusablePassword(): string {
    return `Guest-Unusable-${crypto.randomBytes(64).toString('hex')}`;
  }

  private generateGuestEmail(): string {
    return `guest_${crypto.randomUUID()}@guest.smart-depannage.local`;
  }

  private async createOneTimeToken(data: {
    userId: number;
    type: AuthTokenType;
    /** sha256 of the link token, or hashOneTimeCode() of an SMS code. */
    tokenHash: string;
    expiresInMs: number;
  }) {
    await this.prisma.authToken.updateMany({
      where: {
        userId: data.userId,
        type: data.type,
        usedAt: null,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });

    return this.prisma.authToken.create({
      data: {
        userId: data.userId,
        type: data.type,
        tokenHash: data.tokenHash,
        expiresAt: new Date(Date.now() + data.expiresInMs),
      },
    });
  }

  private async findInterventionByPublicToken(
    interventionId: number,
    rawTrackingToken: string,
  ) {
    const intervention = await this.prisma.intervention.findFirst({
      where: {
        id: interventionId,
        trackingToken: this.hashToken(rawTrackingToken),
      },
      include: {
        client: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            isGuest: true,
          },
        },
        artisan: {
          select: {
            id: true,
            name: true,
            phone: true,
            latitude: true,
            longitude: true,
          },
        },
        subService: true,
        events: {
          orderBy: {
            createdAt: 'asc',
          },
        },
        quotes: {
          include: {
            items: true,
          },
          orderBy: {
            createdAt: 'desc',
          },
        },
        payments: {
          orderBy: {
            createdAt: 'desc',
          },
        },
        invoice: true,
        review: true,
      },
    });

    if (!intervention) {
      throw new NotFoundException('Lien de suivi invalide ou expiré.');
    }

    return intervention;
  }

  // ==========================================================
  // 2. FIND OR CREATE GUEST PROFILE
  // No default password. Password is random and never sent.
  // ==========================================================

  private async findOrCreateGuestProfile(
    dto: CreateGuestInterventionDto,
    attempt = 1,
  ): Promise<User> {
    const contactPhone = dto.contactPhone?.trim();
    const contactEmail = dto.contactEmail?.trim()?.toLowerCase();

    if (!contactPhone && !contactEmail) {
      throw new BadRequestException(
        'Un téléphone ou un email est obligatoire pour une demande invitée.',
      );
    }

    // 400 when the number cannot be a phone number (no SMS could ever reach it).
    const phone = phoneColumns(contactPhone);

    const matches = await this.prisma.user.findMany({
      where: {
        OR: [
          contactEmail ? { email: contactEmail } : undefined,
          phoneWhere(contactPhone),
        ].filter(Boolean) as any[],
      },
      orderBy: { id: 'asc' },
    });

    // The e-mail is unique and always counts. A deleted or deactivated account
    // that only shares the phone is ignored.
    const relevant = matches.filter(
      (user) =>
        (contactEmail && user.email === contactEmail) ||
        (user.isActive && !user.deletedAt),
    );

    // P0-09: a public request must never attach itself to a real account
    // (client, artisan, staff). Only a previous guest profile is reused, and
    // the answer does not depend on the order the database returns rows in.
    if (relevant.some((user) => !user.isGuest)) {
      throw new ConflictException(
        'Un compte existe déjà avec ces coordonnées. Connectez-vous pour envoyer votre demande.',
      );
    }

    // A profile is reused only when it agrees with EVERYTHING the form says. Somebody
    // can file a request with another person's number (or address) next to their own
    // details; if the next request from the real owner were attached to that profile,
    // the notices and the tracking would go to the first person. A profile that does
    // not agree is left alone and a new one is made (the details it holds stay with it).
    const reusable = relevant.filter((user) =>
      guestAgreesWithForm(user, { email: contactEmail, phoneKey: phone.phoneKey }),
    );

    const existingUser =
      reusable.find((user) => contactEmail && user.email === contactEmail) ??
      reusable[0];

    if (existingUser) {
      return existingUser;
    }

    // A number belongs to one account. If a deleted or deactivated account still
    // holds it, the new guest profile is created without it: the number stays on
    // the request itself (contactPhone), where the tracking SMS is read from.
    const numberTaken = matches.some(
      (user) =>
        phone.phoneKey !== null &&
        (user.phoneKey === phone.phoneKey || user.phone === phone.phone),
    );

    // The address is unique: when a profile that did not agree already has it, the new
    // profile gets a made-up one (it is a guest, it logs in nowhere).
    const emailTaken = Boolean(contactEmail) && matches.some((user) => user.email === contactEmail);

    const unusablePassword = await argon2.hash(this.generateUnusablePassword());

    try {
      return await this.prisma.user.create({
        data: {
          email: contactEmail && !emailTaken ? contactEmail : this.generateGuestEmail(),
          ...(numberTaken ? { phone: null, phoneKey: null } : phone),
          name: dto.contactName || 'Client invité',
          password: unusablePassword,
          role: Role.CLIENT,
          isActive: true,
          isGuest: true,
        },
      });
    } catch (error) {
      // Two requests with the same details at the same moment: the second one
      // finds the profile the first one just made.
      if (isUniqueViolation(error) && attempt < 3) {
        return this.findOrCreateGuestProfile(dto, attempt + 1);
      }

      return rethrowContactConflict(error);
    }
  }

  // ==========================================================
  // 3. CREATE GUEST INTERVENTION
  // Public request without account
  // ==========================================================

  async createGuestIntervention(dto: CreateGuestInterventionDto) {
    // Before the visitor's profile exists: a request that cannot be taken leaves nothing behind (P1-10).
    // The pictures of a visitor's request come afterwards, on the tracking link, so the answer says
    // whether this service expects some.
    const service = await checkRequestedService(this.prisma, {
      serviceType: dto.serviceType,
      subServiceId: dto.subServiceId,
    });

    const guestUser = await this.findOrCreateGuestProfile(dto);

    const rawTrackingToken = this.generateRawToken();
    const trackingTokenHash = this.hashToken(rawTrackingToken);

    const intervention = await this.prisma.intervention.create({
      data: {
        clientId: guestUser.id,

        serviceType: dto.serviceType,
        subServiceId: service.subServiceId ?? undefined,
        description: dto.description,
        urgency: dto.urgency || UrgencyLevel.NORMAL,

        address: dto.address,
        latitude: dto.latitude,
        longitude: dto.longitude,

        preferredDate: dto.preferredDate
          ? new Date(dto.preferredDate)
          : undefined,
        preferredStartTime: dto.preferredStartTime,
        preferredEndTime: dto.preferredEndTime,

        contactName: dto.contactName,
        contactPhone: dto.contactPhone,

        accessInstructions: dto.accessInstructions,
        buildingInfo: dto.buildingInfo,
        floor: dto.floor,
        apartmentCode: dto.apartmentCode,

        status: initialStatus() as Status,
        trackingToken: trackingTokenHash,
      },
      include: {
        client: {
          select: {
            id: true,
            name: true,
            phone: true,
            email: true,
            isGuest: true,
          },
        },
        subService: true,
      },
    });

    // The request exists: a timeline line that cannot be written must not stop the
    // alert and the customer's link (the visitor would submit it a second time).
    await this.recordEvent({
      interventionId: intervention.id,
      type: InterventionEventType.REQUEST_CREATED,
      title: 'Demande créée',
      message: 'Votre demande a été enregistrée.',
      createdById: guestUser.id,
    });

    await this.recordEvent({
      interventionId: intervention.id,
      type: InterventionEventType.ADMIN_REVIEWING,
      title: 'Analyse par notre équipe',
      message: 'Un administrateur va examiner votre demande.',
    });

    // The back office hears about it at once: the open dashboards, each staff
    // member's notifications and, when ADMIN_ALERT_PHONE is set, a text. Never throws.
    await this.staffAlerts.newRequest(intervention);

    const trackingUrl = buildTrackingUrl(intervention.id, rawTrackingToken);

    await this.sendTrackingLink(guestUser.id, intervention.id, dto, trackingUrl);

    // The visitor's copy of the request: no column of the back office (internal notes, hash of the
    // tracking token), and no profile nor its id: a visitor who types somebody else's number
    // must not be told whose profile it is (name, e-mail, id), nor whether one exists.
    const publicRequest = interventionForTracking(intervention);

    return {
      intervention: publicRequest,
      trackingUrl,
      rawTrackingToken,
      // The service picked asks for photos of the problem: the page offers them next, on the tracking link.
      photosRequired: service.photosRequired,
      // The link is also sent by SMS and e-mail when that is possible, but the
      // visitor is not told whether it was: this answer carries it either way.
      message: 'Demande créée avec succès. Conservez le lien de suivi.',
    };
  }

  /** A timeline line is nice to have: failing to write one is logged, never thrown. */
  private async recordEvent(event: Parameters<InterventionEventsService['create']>[0]) {
    try {
      await this.events.create(event);
    } catch (error: any) {
      this.logger.warn(`Timeline line not written (${describeError(error)})`);
    }
  }

  /**
   * The customer's link, by SMS and by e-mail when an address was given.
   *
   * Anyone can type any number or address here: each destination gets a few
   * messages per hour at most, whatever the visitor does, and a destination that
   * is over its share is skipped without a word (the answer to the request
   * carries the link anyway). An address that cannot receive mail (made up) is
   * skipped. Nothing here may fail the request: it already exists, and an error
   * now would send the customer to submit it a second time.
   */
  private async sendTrackingLink(
    guestUserId: number,
    interventionId: number,
    dto: { contactName?: string; contactPhone?: string; contactEmail?: string },
    trackingUrl: string,
  ) {
    // The name is typed by the visitor and ends up in an e-mail sent to somebody else's
    // mailbox (and in the editable templates): a name or nothing (see greetingName).
    const name = greetingName(dto.contactName);
    const greeting = name ? `Bonjour ${name},` : 'Bonjour,';
    const vars = { name, link: trackingUrl, reference: interventionId };

    // A link that is still unsent after a day is no use to somebody who was told to wait.
    const lifetime = 24 * 60 * 60 * 1000;

    // One channel failing must not keep the other from going out.
    try {
      if (dto.contactPhone && this.rateLimit.allowSendTo('sms', dto.contactPhone)) {
        // "#" and not "n°": a character outside the basic SMS alphabet turns the whole
        // message into the 70-character kind, and the bill goes from 2 messages to 3.
        await this.notifications.sendSms(
          dto.contactPhone,
          `Smart Dépannage: votre demande #${interventionId} est enregistrée. Suivez-la ici: ${trackingUrl}`,
          { userId: guestUserId, validForMs: lifetime, template: { key: 'guest.tracking_sms', vars } },
        );
      }
    } catch (error: any) {
      // Kind of error only: the arguments are a phone number and the link.
      this.logger.error(`Tracking link not sent by SMS (${describeError(error)})`);
    }

    try {
      if (
        dto.contactEmail &&
        isDeliverableEmail(dto.contactEmail) &&
        this.rateLimit.allowSendTo('email', dto.contactEmail)
      ) {
        await this.notifications.sendEmail(
          dto.contactEmail,
          'Votre demande Smart Dépannage',
          `${greeting}\n\nVotre demande n°${interventionId} est enregistrée. ` +
            `Suivez son avancement avec ce lien personnel (ne le partagez pas) :\n${trackingUrl}\n\n` +
            `L'équipe Smart Dépannage`,
          { userId: guestUserId, validForMs: lifetime, template: { key: 'guest.tracking_email', vars } },
        );
      }
    } catch (error: any) {
      this.logger.error(`Tracking link not sent by e-mail (${describeError(error)})`);
    }
  }

  // ==========================================================
  // 4. PUBLIC TRACKING
  // ==========================================================

  async track(interventionId: number, rawTrackingToken: string) {
    // What the link's holder may see: their request, the timeline without the back office's
    // lines, the quotes that were sent, what they paid. Never the account behind the request.
    return interventionForTracking(
      await this.findInterventionByPublicToken(interventionId, rawTrackingToken),
    );
  }

  // ==========================================================
  // 4b. PHOTOS FROM THE TRACKING LINK (P1-04)
  // ==========================================================

  /** Photos one request may hold in all, the ones sent before included. */
  static readonly MAX_PHOTOS = 6;

  /** Photos one call may carry (the controller's upload limit says the same). */
  static readonly MAX_PHOTOS_PER_CALL = 5;

  /**
   * The request that goes with this link, without the heavy tracking answer
   * (events, quotes, payments...): only what a photo or a report needs.
   */
  private async findForLink(interventionId: number, rawTrackingToken: string) {
    const intervention = await this.prisma.intervention.findFirst({
      where: {
        id: interventionId,
        trackingToken: this.hashToken(String(rawTrackingToken ?? '')),
      },
      select: { id: true, clientId: true, status: true, photos: true },
    });

    if (!intervention) {
      throw new NotFoundException('Lien de suivi invalide ou expiré.');
    }

    return intervention;
  }

  /**
   * Pictures of the problem, added after the request was made. The link is the
   * only proof of who is asking, so before anything is stored: the link is
   * checked, the request must still be open (a finished or cancelled one takes no
   * more photos), the number of photos is capped, and the calls are counted per
   * request on top of the limit per visitor address.
   */
  async uploadPhotos(
    interventionId: number,
    rawTrackingToken: string,
    uploads: Express.Multer.File[] | undefined,
  ) {
    // One call at a time per request: the room left is read and then used, and two
    // calls at once would both see it empty (10 calls of 5 pictures made 50 photos).
    return this.photoLock.run(`guest-photos:${interventionId}`, async () => {
      const intervention = await this.findForLink(interventionId, rawTrackingToken);

      this.rateLimit.assertWithin(`guest-photos:${intervention.id}`, RATE_RULES.guestPhotoUploads);

      if (!uploads?.length) {
        throw new BadRequestException('Aucune photo envoyée.');
      }

      if (uploads.length > GuestService.MAX_PHOTOS_PER_CALL) {
        throw new BadRequestException(
          `Maximum ${GuestService.MAX_PHOTOS_PER_CALL} photos par envoi.`,
        );
      }

      const open = [...statusesInGroup('waiting'), ...statusesInGroup('active')];

      if (!open.includes(intervention.status)) {
        throw new ForbiddenException("Cette demande est clôturée: il n'est plus possible d'ajouter des photos.");
      }

      const room = GuestService.MAX_PHOTOS - (intervention.photos?.length ?? 0);

      if (uploads.length > room) {
        throw new BadRequestException(
          room > 0
            ? `Cette demande peut encore recevoir ${room} photo(s) (maximum ${GuestService.MAX_PHOTOS}).`
            : `Cette demande a déjà ${GuestService.MAX_PHOTOS} photos (maximum).`,
        );
      }

      const stored: Array<{ id: number }> = [];
      const refused: Array<{ position: number; reason: string }> = [];
      let firstRefusal: HttpException | undefined;

      // One after the other. A picture that is refused (not an image, too big, damaged)
      // does not undo the ones that were fine: the answer says which were kept and which not.
      for (const [index, upload] of uploads.entries()) {
        try {
          const asset = await this.files.uploadGuestDamagePhoto(
            { id: intervention.id, clientId: intervention.clientId },
            upload,
          );

          stored.push({ id: asset.id });
        } catch (error) {
          // Anything that is not a refusal of this picture (disk, database) is a real failure.
          if (!(error instanceof HttpException) || error.getStatus() >= 500) throw error;

          firstRefusal ??= error;
          refused.push({ position: index + 1, reason: error.message });
        }
      }

      // Nothing was kept: the same refusal as a single upload would give.
      if (stored.length === 0 && firstRefusal) throw firstRefusal;

      return {
        added: stored.length,
        photos: stored,
        refused,
        message: stored.length > 1 ? 'Photos ajoutées à votre demande.' : 'Photo ajoutée à votre demande.',
      };
    });
  }

  // ==========================================================
  // 4c. PROBLEM REPORTED FROM THE TRACKING LINK (P1-04)
  // ==========================================================

  /**
   * Complaints that may be opened from the link of ONE request, in all. The
   * hourly counter forgets when the server restarts; this one is in the database.
   * Beyond it the customer is sent to support, who can still reach them.
   */
  static readonly GUEST_COMPLAINT_CEILING = 5;

  /**
   * A problem reported by the holder of a tracking link. It opens a complaint on
   * the request (so the support staff see it in their notifications and in the
   * complaint list, like any other), adds a line to the timeline and lights up
   * the dashboard that is open.
   *
   * Abuse limits: the texts are capped by the DTO; at most 3 reports a day per
   * request (every attempt counts) and 5 complaints in all per request.
   */
  async reportProblem(interventionId: number, rawTrackingToken: string, dto: GuestProblemReportDto) {
    const intervention = await this.findForLink(interventionId, rawTrackingToken);

    this.rateLimit.assertWithin(`guest-problems:${intervention.id}`, RATE_RULES.guestProblemReports);

    const opened = await this.prisma.complaint.count({
      where: { interventionId: intervention.id, userId: intervention.clientId },
    });

    if (opened >= GuestService.GUEST_COMPLAINT_CEILING) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          message:
            'Vous avez déjà signalé plusieurs problèmes sur cette demande. Notre équipe les traite: contactez le support pour la suite.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const description = dto.description.trim();
    const title = (dto.title?.trim() || description).slice(0, 120);

    // The complaint belongs to the guest profile of the request: the same
    // person, the same rights as a customer who is signed in.
    const complaint = await this.complaints.createComplaint(
      intervention.clientId,
      Role.CLIENT,
      intervention.id,
      { title, description },
      // The complaint thread keeps the details. The request's own notes (a review the
      // customer wrote, the log of reports on the older route) are not replaced by
      // the title of an anonymous report.
      { keepFeedbackNotes: true },
    );

    await this.events
      .create({
        interventionId: intervention.id,
        type: InterventionEventType.COMPLAINT_OPENED,
        title: 'Problème signalé',
        message: 'Votre signalement a été transmis à notre équipe.',
        createdById: intervention.clientId,
      })
      .catch((error: any) => {
        this.logger.warn(`Timeline line for a reported problem not written (${describeError(error)})`);
      });

    await this.staffAlerts.problemReported({
      interventionId: intervention.id,
      complaintId: complaint.id,
      issue: description,
    });

    return {
      id: complaint.id,
      status: complaint.status,
      message: 'Votre signalement a été transmis à notre équipe.',
    };
  }

  // ==========================================================
  // 5. GUEST QUOTE ACTIONS
  // Receive quote / accept / reject / ask modification
  // ==========================================================

  async getQuotes(interventionId: number, rawTrackingToken: string) {
    const intervention = await this.findInterventionByPublicToken(
      interventionId,
      rawTrackingToken,
    );

    return quotesForParties(intervention.quotes);
  }

  async acceptQuote(
    interventionId: number,
    quoteId: number,
    rawTrackingToken: string,
    dto: GuestQuoteActionDto,
  ) {
    const intervention = await this.findInterventionByPublicToken(
      interventionId,
      rawTrackingToken,
    );

    const quote = await this.prisma.quote.findUnique({
      where: { id: quoteId },
    });

    if (!quote || quote.interventionId !== intervention.id) {
      throw new NotFoundException('Devis introuvable.');
    }

    if (quote.status !== QuoteStatus.SENT) {
      throw new BadRequestException(
        'Ce devis ne peut plus être accepté.',
      );
    }

    const updatedQuote = await this.prisma.quote.update({
      where: { id: quoteId },
      data: {
        status: QuoteStatus.ACCEPTED,
        clientNote: dto.note,
      },
      include: {
        items: true,
      },
    });

    // The customer accepted a quote: the job moves on if it is waiting for it.
    // If it is somewhere else (already assigned, say) the status is left alone.
    await transitionStatus(this.prisma, {
      id: intervention.id,
      to: Status.QUOTE_ACCEPTED,
      actor: { kind: 'client', userId: intervention.clientId },
      data: { quoteAcceptedAt: new Date() },
      soft: true,
    });

    await this.events.create({
      interventionId: intervention.id,
      type: InterventionEventType.QUOTE_ACCEPTED,
      title: 'Devis accepté',
      message: dto.note || 'Le client invité a accepté le devis.',
      createdById: intervention.clientId,
    });

    // Each dispatcher and admin gets their own notification (never throws).
    await this.notifications.notifyQuoteAccepted(updatedQuote.id, intervention.clientId);

    return quoteForParties(updatedQuote);
  }

  async rejectQuote(
    interventionId: number,
    quoteId: number,
    rawTrackingToken: string,
    dto: GuestQuoteActionDto,
  ) {
    const intervention = await this.findInterventionByPublicToken(
      interventionId,
      rawTrackingToken,
    );

    const quote = await this.prisma.quote.findUnique({
      where: { id: quoteId },
    });

    if (!quote || quote.interventionId !== intervention.id) {
      throw new NotFoundException('Devis introuvable.');
    }

    const updatedQuote = await this.prisma.quote.update({
      where: { id: quoteId },
      data: {
        status: QuoteStatus.REJECTED,
        clientNote: dto.note,
      },
    });

    await this.events.create({
      interventionId: intervention.id,
      type: InterventionEventType.QUOTE_REJECTED,
      title: 'Devis refusé',
      message: dto.note || 'Le client invité a refusé le devis.',
      createdById: intervention.clientId,
    });

    return quoteForParties(updatedQuote);
  }

  async requestQuoteModification(
    interventionId: number,
    quoteId: number,
    rawTrackingToken: string,
    dto: GuestQuoteActionDto,
  ) {
    const intervention = await this.findInterventionByPublicToken(
      interventionId,
      rawTrackingToken,
    );

    const quote = await this.prisma.quote.findUnique({
      where: { id: quoteId },
    });

    if (!quote || quote.interventionId !== intervention.id) {
      throw new NotFoundException('Devis introuvable.');
    }

    const updatedQuote = await this.prisma.quote.update({
      where: { id: quoteId },
      data: {
        status: QuoteStatus.MODIFICATION_REQUESTED,
        clientNote: dto.note,
      },
    });

    await this.events.create({
      interventionId: intervention.id,
      type: InterventionEventType.QUOTE_MODIFICATION_REQUESTED,
      title: 'Modification du devis demandée',
      message:
        dto.note || 'Le client invité demande une modification du devis.',
      createdById: intervention.clientId,
    });

    return quoteForParties(updatedQuote);
  }

  // ==========================================================
  // 6. GUEST PAYMENT
  // No Stripe yet. ONLINE is only a placeholder request.
  // ==========================================================

  async createGuestPayment(
    interventionId: number,
    rawTrackingToken: string,
    dto: GuestPaymentDto,
  ) {
    const intervention = await this.findInterventionByPublicToken(
      interventionId,
      rawTrackingToken,
    );

    const acceptedQuote = await this.prisma.quote.findFirst({
      where: {
        interventionId: intervention.id,
        status: QuoteStatus.ACCEPTED,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    if (!acceptedQuote) {
      throw new BadRequestException(
        'Aucun devis accepté trouvé pour cette intervention.',
      );
    }

    const status =
      dto.method === PaymentMethod.ONLINE
        ? PaymentStatus.PENDING
        : PaymentStatus.AWAITING_CONFIRMATION;

    const payment = await this.prisma.payment.create({
      data: {
        interventionId: intervention.id,
        quoteId: acceptedQuote.id,
        method: dto.method,
        status,
        amount: acceptedQuote.amountTTC,
        reference: dto.reference,
        clientNote: dto.clientNote,
      },
    });

    // A payment request must not overwrite a job that is still being worked on:
    // soft, so the payment is recorded and the status only moves when it should.
    await transitionStatus(this.prisma, {
      id: intervention.id,
      to: Status.PAYMENT_PENDING,
      actor: { kind: 'client', userId: intervention.clientId },
      data: { paymentPendingAt: new Date() },
      soft: true,
    });

    await this.events.create({
      interventionId: intervention.id,
      type: InterventionEventType.PAYMENT_PENDING,
      title: 'Paiement en attente',
      message:
        dto.method === PaymentMethod.ONLINE
          ? 'Demande de paiement en ligne créée. Aucun prestataire externe n’est encore connecté.'
          : `Paiement ${dto.method} en attente de confirmation.`,
      createdById: intervention.clientId,
    });

    return {
      payment: paymentForClient(payment),
      instructions:
        dto.method === PaymentMethod.ONLINE
          ? 'Paiement en ligne non connecté pour le moment. Cette demande reste en attente.'
          : dto.method === PaymentMethod.BANK_TRANSFER
            ? 'Effectuez le virement puis envoyez la référence.'
            : 'Paiement en espèces à confirmer par l’administration.',
    };
  }

  // ==========================================================
  // 7. GUEST FEEDBACK
  // ==========================================================

  async submitFeedback(
    interventionId: number,
    rawTrackingToken: string,
    dto: GuestFeedbackDto,
  ) {
    const intervention = await this.findInterventionByPublicToken(
      interventionId,
      rawTrackingToken,
    );

    // Finished jobs, whichever spelling of the status the row uses (an invoiced
    // job is INVOICE_SENT, which the old check did not know about).
    if (!statusesInGroup('completed').includes(intervention.status)) {
      throw new BadRequestException(
        'Vous pouvez laisser un avis uniquement après la fin de l’intervention.',
      );
    }

    // One opinion per job (P1-16): the review is the record, and the job keeps the same figures
    // for the back office screens that read them. A second answer is refused, not written over.
    if (intervention.review) {
      throw new ConflictException(ALREADY_REVIEWED);
    }

    const { updated, review } = await this.saveOpinion(intervention, dto);

    // The opinion is saved: a timeline line that cannot be written must not turn it into an error
    // (the visitor would send it again and be told it exists).
    await this.recordEvent({
      interventionId: intervention.id,
      type: InterventionEventType.REVIEW_SUBMITTED,
      title: 'Avis reçu',
      message: `Le client invité a laissé une note de ${dto.rating}/5.`,
      createdById: intervention.clientId,
    });

    // The answer is the job as the link's holder sees it, with the opinion just saved (without its moderation).
    return interventionForTracking({ ...updated, review });
  }

  /**
   * The review and the figures of the job, both rows or neither, so a job never shows a rating without
   * its review, and two answers sent at the same moment end in one review (the key of
   * `Review.interventionId` is unique). Not a route: what it returns never leaves the service as it is.
   */
  private async saveOpinion(
    intervention: { id: number; clientId: number; artisanId: number | null; hasIssue: boolean | null; feedbackNotes: string | null },
    dto: GuestFeedbackDto,
  ) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const review = await tx.review.create({
          data: {
            interventionId: intervention.id,
            // The guest profile of the request: the opinion is that of the person who asked for the job.
            clientId: intervention.clientId,
            // A job closed by the back office without an artisan can still be commented on; the
            // opinion then counts for nobody's rating.
            artisanId: intervention.artisanId ?? null,
            rating: dto.rating,
            comment: dto.feedbackNotes?.trim() || null,
            isOnTime: dto.isOnTime,
            // Like every review: it is read by the back office first, and shown to nobody before.
            status: ReviewModerationStatus.PENDING,
            isVisible: false,
          },
        });

        const updated = await tx.intervention.update({
          where: { id: intervention.id },
          data: {
            rating: dto.rating,
            isOnTime: dto.isOnTime,
            hasIssue: dto.hasIssue ?? intervention.hasIssue ?? false,
            feedbackNotes: notesAfterReview(
              intervention.feedbackNotes,
              dto.feedbackNotes,
              Boolean(intervention.hasIssue),
            ),
          },
        });

        return { updated, review };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(ALREADY_REVIEWED);
      }

      throw error;
    }
  }

  // ==========================================================
  // 8. REQUEST ACCOUNT ACTIVATION
  // Send magic link and/or OTP
  // ==========================================================

  async requestAccountActivation(dto: RequestGuestActivationDto, requester = 'unknown') {
    if (!dto.email && !dto.phone) {
      throw new BadRequestException('Email ou téléphone obligatoire.');
    }

    const genericAnswer = {
      message:
        'Si un profil invité existe, un lien ou code d’activation a été envoyé.',
    };

    // P0-07: at most 3 activation messages per email / phone per hour. Over
    // the limit the answer is the same generic one, so nothing is revealed.
    // The lookup below matches the email OR the phone, so the quota is counted
    // on every identifier given, in its canonical spelling: "A.B+1@gmail.com"
    // and "ab@gmail.com" are one mailbox, "22 123 456" and "+21622123456" one phone.
    const email = dto.email ? canonicalEmail(dto.email) : null;
    const phoneKey = dto.phone ? phoneKeyOf(dto.phone) : null;

    if ((dto.email && !email) || (dto.phone && !phoneKey)) {
      return genericAnswer;
    }

    const identifiers = [
      email ? `guest-activation:email:${email}` : null,
      phoneKey ? `guest-activation:phone:${phoneKey}` : null,
    ].filter((value): value is string => Boolean(value));

    // Two counters: what one requester (client address) may ask for, and what the
    // address or number may receive whoever asks. The destination counter is higher
    // and is only used by requests that passed the first one, so one troublemaker
    // cannot use up the quota of the real owner.
    const requesterOk = identifiers
      .map((key) => this.rateLimit.tryConsume(`${key}:from:${requester}`, RATE_RULES.codeSendPerTarget))
      .every(Boolean);

    if (!requesterOk) {
      return genericAnswer;
    }

    const destinationOk = identifiers
      .map((key) => this.rateLimit.tryConsume(key, RATE_RULES.codeSendPerDestination))
      .every(Boolean);

    if (!destinationOk) {
      return genericAnswer;
    }

    const candidates = await this.prisma.user.findMany({
      where: {
        OR: [
          dto.email ? { email: dto.email.trim().toLowerCase() } : undefined,
          phoneWhere(dto.phone),
        ].filter(Boolean) as any[],
        isGuest: true,
        deletedAt: null,
      },
      orderBy: { id: 'asc' },
    });

    // The e-mail is unique, so it wins when both details were given.
    const user =
      candidates.find(
        (candidate) =>
          dto.email && candidate.email === dto.email.trim().toLowerCase(),
      ) ?? candidates[0];

    if (!user) {
      return genericAnswer;
    }

    // Two separate proofs, each sent where only its owner reads it:
    //  - the LINK goes to the guest's mailbox and proves the e-mail address;
    //  - the CODE goes to the guest's phone and proves the phone number.
    // The link is not repeated in the SMS: a link that vouches for an e-mail
    // address must not be usable by whoever only holds the phone.
    if (user.email && isDeliverableEmail(user.email)) {
      const rawMagicToken = this.generateRawToken();

      await this.createOneTimeToken({
        userId: user.id,
        type: AuthTokenType.GUEST_MAGIC_LINK,
        tokenHash: this.hashToken(rawMagicToken),
        expiresInMs: 30 * 60 * 1000,
      });

      const activationUrl = `${this.getFrontendUrl()}/guest/activate?token=${rawMagicToken}`;

      await this.notifications.sendEmail(
        user.email,
        'Activation de votre compte',
        `Cliquez sur ce lien pour activer votre compte: ${activationUrl}`,
        {
          userId: user.id,
          template: { key: 'guest.activation_email', vars: { name: user.name, link: activationUrl } },
          validForMs: 30 * 60 * 1000, // the link's life
          replaces: `guest:magic-link:${user.id}`,
        },
      );
    }

    if (user.phone) {
      const otp = generateSixDigitCode();

      await this.createOneTimeToken({
        userId: user.id,
        type: AuthTokenType.GUEST_OTP,
        tokenHash: hashOneTimeCode(user.id, 'guest-activation', otp),
        expiresInMs: 10 * 60 * 1000,
      });

      await this.notifications.sendSms(
        user.phone,
        `Smart Dépannage: votre code d’activation est ${otp}. Il est valable 10 minutes.`,
        {
          userId: user.id,
          template: {
            key: 'guest.activation_sms',
            vars: { name: user.name, code: otp },
          },
          validForMs: 10 * 60 * 1000, // the code's life
          replaces: `guest:otp:${user.id}`,
        },
      );
    }

    return genericAnswer;
  }

  /**
   * The address an account was opened with by SMS code is not proven yet: a link
   * goes to it (same link, template and replacement key as AuthService's). It never
   * fails the activation that was just done.
   */
  private async sendEmailVerificationLink(user: { id: number; name: string | null; email: string }) {
    if (!isDeliverableEmail(user.email)) return;

    try {
      const rawToken = generateLinkToken();

      await this.createOneTimeToken({
        userId: user.id,
        type: AuthTokenType.EMAIL_VERIFICATION,
        tokenHash: hashLinkToken(rawToken),
        expiresInMs: 24 * 60 * 60 * 1000,
      });

      const link = `${this.getFrontendUrl()}/verify-email?token=${rawToken}`;

      await this.notifications.sendEmail(
        user.email,
        'Vérification de votre email',
        `Cliquez sur ce lien pour vérifier votre email: ${link}`,
        {
          userId: user.id,
          template: { key: 'auth.email_verification', vars: { name: user.name, link } },
          validForMs: 24 * 60 * 60 * 1000,
          replaces: `auth:EMAIL_VERIFICATION:${user.id}`,
        },
      );
    } catch (error: any) {
      this.logger.warn(`Verification e-mail not queued after activation (${describeError(error)})`);
    }
  }

  // ==========================================================
  // 9. ACTIVATE GUEST ACCOUNT
  // User creates a real password later
  // ==========================================================

  async activateGuestAccount(dto: ActivateGuestAccountDto) {
    const hasLink = Boolean(dto.token && String(dto.token).trim());
    const phoneKey = phoneKeyOf(dto.phone);
    const usesOtp = !hasLink && Boolean(phoneKey && String(dto.otp ?? '').trim());

    if (!hasLink && !usesOtp) {
      throw new BadRequestException(
        'Token magique ou couple téléphone + OTP obligatoire.',
      );
    }

    let tokenRecord:
      | {
          id: number;
          userId: number;
          type: AuthTokenType;
        }
      | null = null;

    // The failure counter follows the canonical number, so writing it another
    // way ("22 123 456", "+21622123456") does not give a fresh set of guesses.
    const otpLockKey = `otp:guest:${phoneKey}`;

    if (hasLink) {
      tokenRecord = await this.prisma.authToken.findFirst({
        where: {
          tokenHash: this.hashToken(dto.token!),
          type: AuthTokenType.GUEST_MAGIC_LINK,
          usedAt: null,
          revokedAt: null,
          expiresAt: {
            gt: new Date(),
          },
        },
        select: {
          id: true,
          userId: true,
          type: true,
        },
      });

      if (!tokenRecord) {
        throw new BadRequestException('Lien ou code invalide ou expiré.');
      }
    } else {
      // P0-07: a 6 digit code must not be guessable by trying all of them.
      this.rateLimit.assertNotLocked(otpLockKey);
      // Counted BEFORE the lookup and cleared when the code is right: requests sent
      // at once must not all pass the lock test before the first failure is written
      // down. The attempt counts whether or not a guest has this number: the answer
      // is the same.
      this.rateLimit.registerFailure(otpLockKey, RATE_RULES.otpFailures);

      // A number belongs to one account, so this is one guest. Rows written
      // before that rule may share a number: the code is then looked for in
      // each of them (it is hashed with the id of the user it was made for).
      const guests = await this.prisma.user.findMany({
        where: {
          ...phoneWhere(dto.phone),
          isGuest: true,
          deletedAt: null,
        },
        select: { id: true },
        take: 5,
      });

      if (guests.length) {
        tokenRecord = await this.prisma.authToken.findFirst({
          where: {
            OR: guests.map((guest) => ({
              userId: guest.id,
              tokenHash: hashOneTimeCode(guest.id, 'guest-activation', String(dto.otp).trim()),
            })),
            type: AuthTokenType.GUEST_OTP,
            usedAt: null,
            revokedAt: null,
            expiresAt: {
              gt: new Date(),
            },
          },
          select: {
            id: true,
            userId: true,
            type: true,
          },
        });
      }

      if (!tokenRecord) {
        throw new BadRequestException('Lien ou code invalide ou expiré.');
      }

      this.rateLimit.clear(otpLockKey);
    }

    const user = await this.prisma.user.findUnique({
      where: { id: tokenRecord.userId },
    });

    if (!user || !user.isGuest) {
      throw new BadRequestException('Ce compte est déjà activé ou introuvable.');
    }

    // Which address the account is opened with. The e-mail on a guest profile was
    // typed on a public form by whoever filled it in: nothing has shown it is the
    // address of the person activating. Each proof vouches for what it was sent to:
    //  - the LINK went to that mailbox, so the address is proven and stays;
    //  - the SMS CODE went to the phone, so the PHONE is proven and the person chooses
    //    the address they will log in with (the one typed on the form is dropped
    //    unless they type it too). That address is not verified yet: a link is sent to it.
    const askedEmail = dto.email?.trim().toLowerCase();
    let email = user.email;

    if (tokenRecord.type === AuthTokenType.GUEST_MAGIC_LINK) {
      if (isMadeUpGuestEmail(user.email)) {
        throw new BadRequestException('Utilisez le code reçu par SMS.');
      }

      if (askedEmail && askedEmail !== user.email) {
        throw new BadRequestException(
          "Ce lien vaut pour l'adresse e-mail du profil. Pour en changer, connectez-vous puis utilisez « changer d'adresse e-mail ».",
        );
      }
    } else {
      if (!askedEmail) {
        throw new BadRequestException(
          "Indiquez l'adresse e-mail avec laquelle vous vous connecterez.",
        );
      }

      if (!isDeliverableEmail(askedEmail)) {
        throw new BadRequestException('Adresse e-mail invalide.');
      }

      if (askedEmail !== user.email) {
        const existingEmail = await this.prisma.user.findUnique({
          where: { email: askedEmail },
          select: { id: true },
        });

        if (existingEmail && existingEmail.id !== user.id) {
          throw new BadRequestException('Cet email est déjà utilisé.');
        }
      }

      email = askedEmail;
    }

    const hashedPassword = await argon2.hash(dto.password);

    const updatedUser = await this.prisma.$transaction(async (tx) => {
      // Single use, even when two requests carry the same code at once.
      const claimed = await tx.authToken.updateMany({
        where: { id: tokenRecord!.id, usedAt: null, revokedAt: null },
        data: { usedAt: new Date(), revokedAt: new Date() },
      });

      if (claimed.count !== 1) {
        throw new BadRequestException('Lien ou code invalide ou expiré.');
      }

      const activated = await tx.user.update({
        where: { id: user.id },
        data: {
          email,
          name: dto.name || user.name,
          // The link vouches for the mailbox only. The number on a guest profile was typed
          // on a public form by whoever filled it in: nobody has shown it is this person's,
          // so the account does not keep it (the requests keep theirs). It is added
          // again with the SMS code when the person wants it (POST /users/me/phone-change).
          ...(tokenRecord?.type === AuthTokenType.GUEST_MAGIC_LINK && !user.phoneVerifiedAt
            ? { phone: null, phoneKey: null }
            : {}),
          password: hashedPassword,
          isGuest: false,
          guestActivatedAt: new Date(),
          passwordChangedAt: new Date(),
          // Each proof vouches only for what it was sent to: the code for the
          // phone, the link for the e-mail address.
          phoneVerifiedAt:
            tokenRecord?.type === AuthTokenType.GUEST_OTP
              ? new Date()
              : user.phoneVerifiedAt,
          emailVerifiedAt:
            tokenRecord?.type === AuthTokenType.GUEST_MAGIC_LINK ? new Date() : null,
        },
        select: {
          id: true,
          email: true,
          name: true,
          phone: true,
          role: true,
          isGuest: true,
          guestActivatedAt: true,
          emailVerifiedAt: true,
          phoneVerifiedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      await tx.authToken.updateMany({
        where: {
          userId: user.id,
          type: {
            in: [
              AuthTokenType.GUEST_MAGIC_LINK,
              AuthTokenType.GUEST_OTP,
            ],
          },
          usedAt: null,
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
        },
      });

      return activated;
    }).catch(rethrowContactConflict);

    if (!updatedUser.emailVerifiedAt) {
      await this.sendEmailVerificationLink(updatedUser);
    }

    return {
      user: updatedUser,
      message:
        'Compte activé avec succès. Vous pouvez maintenant vous connecter.',
    };
  }
}
