import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
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
import { initialStatus, statusesInGroup } from '../intervention-workflow/intervention-status';
import { transitionStatus } from '../intervention-workflow/transition-status';

import { CreateGuestInterventionDto } from './dto/create-guest-intervention.dto';
import { GuestQuoteActionDto } from './dto/guest-quote-action.dto';
import { GuestPaymentDto } from './dto/guest-payment.dto';
import { GuestFeedbackDto } from './dto/guest-feedback.dto';
import { RequestGuestActivationDto } from './dto/request-guest-activation.dto';
import { ActivateGuestAccountDto } from './dto/activate-guest-account.dto';

import {
  AuthTokenType,
  InterventionEventType,
  PaymentMethod,
  PaymentStatus,
  QuoteStatus,
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

@Injectable()
export class GuestService {
  private readonly logger = new Logger(GuestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly events: InterventionEventsService,
    private readonly rateLimit: RateLimitService,
  ) {}

  // ==========================================================
  // 1. HELPERS
  // ==========================================================

  private getFrontendUrl(): string {
    return getConfiguredFrontendUrl();
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
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
    const guestUser = await this.findOrCreateGuestProfile(dto);

    const rawTrackingToken = this.generateRawToken();
    const trackingTokenHash = this.hashToken(rawTrackingToken);

    const intervention = await this.prisma.intervention.create({
      data: {
        clientId: guestUser.id,

        serviceType: dto.serviceType,
        subServiceId: dto.subServiceId,
        description: dto.description,
        urgency: dto.urgency || UrgencyLevel.NORMAL,

        address: dto.address,
        latitude: dto.latitude,
        longitude: dto.longitude,

        photos: dto.photos || [],

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

    await this.events.create({
      interventionId: intervention.id,
      type: InterventionEventType.REQUEST_CREATED,
      title: 'Demande créée',
      message: 'Votre demande a été enregistrée.',
      createdById: guestUser.id,
    });

    await this.events.create({
      interventionId: intervention.id,
      type: InterventionEventType.ADMIN_REVIEWING,
      title: 'Analyse par notre équipe',
      message: 'Un administrateur va examiner votre demande.',
    });

    const trackingUrl = `${this.getFrontendUrl()}/guest/tracking/${intervention.id}?token=${rawTrackingToken}`;

    // Anyone can type any number or address here: each destination gets a few
    // messages per hour at most, whatever the visitor does.
    if (dto.contactPhone && this.rateLimit.allowSendTo('sms', dto.contactPhone)) {
      await this.notifications.sendSms(
        dto.contactPhone,
        `Smart Dépannage: votre demande est créée. Suivi sécurisé: ${trackingUrl}`,
        { userId: guestUser.id },
      );
    }

    if (dto.contactEmail && this.rateLimit.allowSendTo('email', dto.contactEmail)) {
      await this.notifications.sendEmail(
        dto.contactEmail,
        'Votre demande Smart Dépannage',
        `Votre demande a été créée. Suivi sécurisé: ${trackingUrl}`,
        { userId: guestUser.id },
      );
    }

    return {
      intervention,
      trackingUrl,
      rawTrackingToken,
      message:
        'Demande créée avec succès. Le lien de suivi a été envoyé au client.',
    };
  }

  // ==========================================================
  // 4. PUBLIC TRACKING
  // ==========================================================

  async track(interventionId: number, rawTrackingToken: string) {
    return this.findInterventionByPublicToken(
      interventionId,
      rawTrackingToken,
    );
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

    return intervention.quotes;
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

    return updatedQuote;
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

    return updatedQuote;
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

    return updatedQuote;
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
      payment,
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

    const updated = await this.prisma.intervention.update({
      where: { id: intervention.id },
      data: {
        rating: dto.rating,
        isOnTime: dto.isOnTime,
        hasIssue: dto.hasIssue ?? false,
        feedbackNotes: dto.feedbackNotes,
      },
    });

    await this.events.create({
      interventionId: intervention.id,
      type: InterventionEventType.REVIEW_SUBMITTED,
      title: 'Avis reçu',
      message: `Le client invité a laissé une note de ${dto.rating}/5.`,
      createdById: intervention.clientId,
    });

    return updated;
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
