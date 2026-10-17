import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import * as argon2 from 'argon2';
import * as crypto from 'crypto';

import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { getFrontendUrl as getConfiguredFrontendUrl } from '../../config/env';
import {
  RATE_RULES,
  RateLimitService,
} from '../../common/rate-limit/rate-limit.service';
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
} from '../../../generated/prisma/client';

@Injectable()
export class GuestService {
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

  private generateOtp(): string {
    // CSPRNG, not Math.random() (P0-07).
    return crypto.randomInt(100000, 1000000).toString();
  }

  private generateUnusablePassword(): string {
    return `Guest-Unusable-${crypto.randomBytes(64).toString('hex')}`;
  }

  private generateGuestEmail(): string {
    return `guest_${crypto.randomUUID()}@guest.smart-depannage.local`;
  }

  private isGeneratedGuestEmail(email: string): boolean {
    return email.endsWith('@guest.smart-depannage.local');
  }

  private async createOneTimeToken(data: {
    userId: number;
    type: AuthTokenType;
    rawToken: string;
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
        tokenHash: this.hashToken(data.rawToken),
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

  private async findOrCreateGuestProfile(dto: CreateGuestInterventionDto) {
    const contactPhone = dto.contactPhone?.trim();
    const contactEmail = dto.contactEmail?.trim()?.toLowerCase();

    if (!contactPhone && !contactEmail) {
      throw new BadRequestException(
        'Un téléphone ou un email est obligatoire pour une demande invitée.',
      );
    }

    const matches = await this.prisma.user.findMany({
      where: {
        OR: [
          contactEmail ? { email: contactEmail } : undefined,
          contactPhone ? { phone: contactPhone } : undefined,
        ].filter(Boolean) as any[],
      },
      orderBy: { id: 'asc' },
    });

    // The e-mail is unique and always counts. A phone number is shared, so a
    // deleted or deactivated account that only shares the phone is ignored.
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

    const existingUser =
      relevant.find((user) => contactEmail && user.email === contactEmail) ??
      relevant[0];

    if (existingUser) {
      return existingUser;
    }

    const unusablePassword = await argon2.hash(this.generateUnusablePassword());

    return this.prisma.user.create({
      data: {
        email: contactEmail || this.generateGuestEmail(),
        phone: contactPhone,
        name: dto.contactName || 'Client invité',
        password: unusablePassword,
        role: Role.CLIENT,
        isActive: true,
        isGuest: true,
      },
    });
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

  async requestAccountActivation(dto: RequestGuestActivationDto) {
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
    // on every identifier given: changing the phone must not reset the count
    // for the same email.
    const identifiers = [dto.email, dto.phone]
      .filter((value): value is string => Boolean(value))
      .map((value) => `guest-activation:${value.trim().toLowerCase()}`);

    const withinLimit = identifiers
      .map((key) => this.rateLimit.tryConsume(key, RATE_RULES.codeSendPerTarget))
      .every(Boolean);

    if (!withinLimit) {
      return genericAnswer;
    }

    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          dto.email ? { email: dto.email.toLowerCase() } : undefined,
          dto.phone ? { phone: dto.phone } : undefined,
        ].filter(Boolean) as any[],
        isGuest: true,
        deletedAt: null,
      },
    });

    if (!user) {
      return genericAnswer;
    }

    const rawMagicToken = this.generateRawToken();

    await this.createOneTimeToken({
      userId: user.id,
      type: AuthTokenType.GUEST_MAGIC_LINK,
      rawToken: rawMagicToken,
      expiresInMs: 30 * 60 * 1000,
    });

    const activationUrl = `${this.getFrontendUrl()}/guest/activate?token=${rawMagicToken}`;

    // (No extra per-destination cap here: the quota above already counts every
    // activation message per identifier, and it is checked before the old link is revoked.)
    if (user.email && !this.isGeneratedGuestEmail(user.email)) {
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
      const otp = this.generateOtp();

      await this.createOneTimeToken({
        userId: user.id,
        type: AuthTokenType.GUEST_OTP,
        rawToken: otp,
        expiresInMs: 10 * 60 * 1000,
      });

      await this.notifications.sendSms(
        user.phone,
        `Smart Dépannage: votre code d’activation est ${otp}. Lien: ${activationUrl}`,
        {
          userId: user.id,
          template: {
            key: 'guest.activation_sms',
            vars: { name: user.name, code: otp, link: activationUrl },
          },
          validForMs: 10 * 60 * 1000, // the code's life
          replaces: `guest:otp:${user.id}`,
        },
      );
    }

    return {
      message:
        'Si un profil invité existe, un lien ou code d’activation a été envoyé.',
    };
  }

  // ==========================================================
  // 9. ACTIVATE GUEST ACCOUNT
  // User creates a real password later
  // ==========================================================

  async activateGuestAccount(dto: ActivateGuestAccountDto) {
    if (!dto.token && (!dto.phone || !dto.otp)) {
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

    if (dto.token) {
      tokenRecord = await this.prisma.authToken.findFirst({
        where: {
          tokenHash: this.hashToken(dto.token),
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
    } else if (dto.phone && dto.otp) {
      // P0-07: a 6 digit code must not be guessable by trying all of them.
      this.rateLimit.assertNotLocked(`otp:guest:${dto.phone}`);

      const user = await this.prisma.user.findFirst({
        where: {
          phone: dto.phone,
          isGuest: true,
          deletedAt: null,
        },
      });

      if (!user) {
        throw new BadRequestException('Code invalide ou expiré.');
      }

      tokenRecord = await this.prisma.authToken.findFirst({
        where: {
          userId: user.id,
          tokenHash: this.hashToken(dto.otp),
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
      if (dto.phone && dto.otp) {
        this.rateLimit.registerFailure(
          `otp:guest:${dto.phone}`,
          RATE_RULES.otpFailures,
        );
      }

      throw new BadRequestException('Lien ou code invalide ou expiré.');
    }

    if (dto.phone && dto.otp) {
      this.rateLimit.clear(`otp:guest:${dto.phone}`);
    }

    const user = await this.prisma.user.findUnique({
      where: { id: tokenRecord.userId },
    });

    if (!user || !user.isGuest) {
      throw new BadRequestException('Ce compte est déjà activé ou introuvable.');
    }

    const normalizedEmail = dto.email?.toLowerCase();

    if (normalizedEmail && normalizedEmail !== user.email) {
      const existingEmail = await this.prisma.user.findUnique({
        where: {
          email: normalizedEmail,
        },
      });

      if (existingEmail && existingEmail.id !== user.id) {
        throw new BadRequestException('Cet email est déjà utilisé.');
      }
    }

    const hashedPassword = await argon2.hash(dto.password);

    const updatedUser = await this.prisma.$transaction(async (tx) => {
      const activated = await tx.user.update({
        where: { id: user.id },
        data: {
          email:
            normalizedEmail ||
            (!this.isGeneratedGuestEmail(user.email) ? user.email : user.email),
          name: dto.name || user.name,
          password: hashedPassword,
          isGuest: false,
          guestActivatedAt: new Date(),
          passwordChangedAt: new Date(),
          phoneVerifiedAt:
            tokenRecord?.type === AuthTokenType.GUEST_OTP
              ? new Date()
              : user.phoneVerifiedAt,
          emailVerifiedAt:
            tokenRecord?.type === AuthTokenType.GUEST_MAGIC_LINK &&
            user.email &&
            !this.isGeneratedGuestEmail(user.email)
              ? new Date()
              : user.emailVerifiedAt,
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

      await tx.authToken.update({
        where: { id: tokenRecord!.id },
        data: {
          usedAt: new Date(),
          revokedAt: new Date(),
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
    });

    return {
      user: updatedUser,
      message:
        'Compte activé avec succès. Vous pouvez maintenant vous connecter.',
    };
  }
}
