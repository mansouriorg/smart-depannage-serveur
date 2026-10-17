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
  async approve(id: number) {
    // A. Find the application
    const application = await this.prisma.artisanApplication.findUnique({ where: { id } });
    if (!application) throw new NotFoundException('Candidature introuvable.');
    if (application.status === 'APPROVED') throw new BadRequestException('Déjà approuvé.');

    const email = application.email.trim().toLowerCase();

    // The e-mail is unique: any account with it blocks the approval.
    // The phone is not unique (clients and guest profiles share numbers), so it
    // only blocks when it already belongs to an artisan or a staff account.
    const existingUser = await this.prisma.user.findFirst({
      where: {
        OR: [
          { email },
          application.phone
            ? {
                phone: application.phone,
                isGuest: false,
                role: { not: Role.CLIENT },
              }
            : undefined,
        ].filter(Boolean) as any[],
      },
      select: { id: true, email: true },
    });

    if (existingUser) {
      throw new BadRequestException(
        existingUser.email === email
          ? 'Un compte existe déjà avec cet email.'
          : 'Un compte artisan ou staff existe déjà avec ce téléphone.',
      );
    }

    // B. Create the real user account.
    // P0-04: no fixed password. The account gets a random unusable one and the
    // artisan chooses their own through a single-use link sent by email.
    const hashedPassword = await argon2.hash(generateUnusablePassword());

    const newUser = await this.prisma.user.create({
      data: {
        name: application.name,
        email,
        phone: application.phone,
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
    });

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
