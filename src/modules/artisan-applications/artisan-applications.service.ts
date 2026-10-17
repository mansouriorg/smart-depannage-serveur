import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateArtisanApplicationDto } from './dto/create-artisan-application.dto';
import {
  generateUnusablePassword,
  issuePasswordSetupLink,
} from '../auth/password-setup';
import * as argon2 from 'argon2';
import { Role } from '../../../generated/prisma/client'; // Adjust path if needed
import {
  phoneColumns,
  phoneWhere,
  rethrowContactConflict,
} from '../../common/contact/phone';

@Injectable()
export class ArtisanApplicationsService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  // 1. Submit Application (Public)
  async create(dto: CreateArtisanApplicationDto) {
    const existing = await this.prisma.artisanApplication.findFirst({
      where: { email: dto.email },
    });
    if (existing) throw new BadRequestException('Une candidature existe déjà pour cet email.');

    // A number that cannot be a phone number is refused here, while the applicant can
    // still fix it, instead of blocking the approval later.
    phoneColumns(dto.phone);

    return this.prisma.artisanApplication.create({
      data: {
        ...dto,
        status: 'PENDING',
      },
    });
  }

  // 2. List All (Admin Only)
  async findAll() {
    return this.prisma.artisanApplication.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  // 3. APPROVE APPLICATION
  async approve(id: number, phoneOverride?: string) {
    // A. Find the application
    const application = await this.prisma.artisanApplication.findUnique({ where: { id } });
    if (!application) throw new NotFoundException('Candidature introuvable.');
    if (application.status === 'APPROVED') throw new BadRequestException('Déjà approuvé.');

    const email = application.email.trim().toLowerCase();

    // Staff can give the number to use when the one on the form is not usable.
    const phoneInput = phoneOverride?.trim() ? phoneOverride : application.phone;
    let phone: ReturnType<typeof phoneColumns>;

    try {
      phone = phoneColumns(phoneInput);
    } catch {
      throw new BadRequestException(
        "Le numéro de téléphone de la candidature n'est pas valide: indiquez le numéro à utiliser dans le champ phone.",
      );
    }

    // The e-mail and the phone number each belong to one account (P1-03, step 4):
    // an existing account with either one blocks the approval. A technician who
    // already has a client account must give a different number, or have the
    // number moved off the client account first.
    const existingUser = await this.prisma.user.findFirst({
      where: {
        OR: [{ email }, phoneWhere(phoneInput)].filter(Boolean) as any[],
      },
      select: { id: true, email: true },
    });

    if (existingUser) {
      throw new BadRequestException(
        existingUser.email === email
          ? 'Un compte existe déjà avec cet email.'
          : 'Un compte existe déjà avec ce téléphone: indiquez un autre numéro dans le champ phone, ou retirez-le de l’autre compte.',
      );
    }

    // B. Create the real user account.
    // P0-04: no fixed password. The account gets a random unusable one and the
    // artisan chooses their own through a single-use link sent by email.
    const hashedPassword = await argon2.hash(generateUnusablePassword());

    const newUser = await this.prisma.user
      .create({
        data: {
          name: application.name,
          email,
          ...phone,
          password: hashedPassword,
          role: Role.ARTISAN,
          isActive: true,
        },
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          role: true,
          isActive: true,
          createdAt: true,
        },
      })
      .catch(rethrowContactConflict);

    // C. Update Application Status
    await this.prisma.artisanApplication.update({
      where: { id },
      data: { status: 'APPROVED' },
    });

    // D. One-time link to choose the password (24h, single use)
    const setupUrl = await issuePasswordSetupLink(this.prisma, newUser.id);

    await this.notifications.sendEmail(
      newUser.email,
      'Votre candidature est acceptée',
      `Bienvenue chez Smart Dépannage. Choisissez votre mot de passe ` +
        `(lien valable 24 heures, usage unique) : ${setupUrl}`,
      {
        userId: newUser.id,
        validForMs: 24 * 60 * 60 * 1000,
        replaces: `auth:PASSWORD_RESET:${newUser.id}`,
      },
    );

    // The password hash is never returned (it used to be).
    // E-mail delivery is simulated for now: give the link to the admin, who
    // passes it on to the artisan.
    const simulated = this.notifications.isEmailSimulated();

    return {
      message: simulated
        ? "Artisan approuvé. Transmettez-lui le lien de création de mot de passe (valable 24 h, usage unique)."
        : 'Artisan approuvé. Un lien de création de mot de passe lui a été envoyé.',
      user: newUser,
      ...(simulated ? { passwordSetupUrl: setupUrl } : {}),
    };
  }

  // 4. Reject Application
  async reject(id: number) {
    return this.prisma.artisanApplication.update({
      where: { id },
      data: { status: 'REJECTED' },
    });
  }
}
