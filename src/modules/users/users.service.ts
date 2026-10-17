import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { issuePasswordSetupLink } from '../auth/password-setup';
import * as argon2 from 'argon2';
import * as crypto from 'crypto';

import {
  Prisma,
  User,
  Role,
  AuthTokenType,
} from '../../../generated/prisma/client';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  // ==========================================================
  // SAFE SELECT — never return password to frontend
  // ==========================================================

  private readonly safeUserSelect = {
    id: true,
    email: true,
    name: true,
    phone: true,
    role: true,

    address: true,
    taxId: true,
    website: true,

    latitude: true,
    longitude: true,

    isActive: true,
    deletedAt: true,

    emailVerifiedAt: true,
    phoneVerifiedAt: true,
    passwordChangedAt: true,

    createdAt: true,
    updatedAt: true,
  };

  // ==========================================================
  // 1. CREATE USER
  // Used by register / admin creation
  // ==========================================================

  async create(data: Prisma.UserCreateInput): Promise<User> {
    // Login looks accounts up in lower case, so they must be stored that way.
    data = { ...data, email: this.normalizeEmail(data.email) };

    const existingUser = await this.prisma.user.findUnique({
      where: { email: data.email },
    });

    if (existingUser) {
      throw new ConflictException('Cet email est déjà utilisé.');
    }

    if (!data.password || typeof data.password !== 'string') {
      throw new BadRequestException('Le mot de passe est obligatoire.');
    }

    const hashedPassword = await argon2.hash(data.password);

    return this.prisma.user.create({
      data: {
        ...data,
        password: hashedPassword,
        isActive: true,
      },
    });
  }

  // ==========================================================
  // 2. CREATE USER BY ADMIN
  // Returns safe user without password
  // ==========================================================

  async createByAdmin(data: Prisma.UserCreateInput) {
    const user = await this.create(data);

    return this.prisma.user.findUnique({
      where: { id: user.id },
      select: this.safeUserSelect,
    });
  }

  // ==========================================================
  // 3. FIND ALL USERS
  // Supports filters + pagination
  // ==========================================================

  async findAll(params?: {
    where?: Prisma.UserWhereInput;
    page?: number;
    limit?: number;
  }) {
    const page = params?.page || 1;
    const limit = params?.limit || 20;
    const skip = (page - 1) * limit;

    const where = params?.where || {};

    const [data, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: this.safeUserSelect,
        orderBy: { id: 'desc' },
        skip,
        take: limit,
      }),

      this.prisma.user.count({
        where,
      }),
    ]);

    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ==========================================================
  // 4. FIND ONE FULL USER
  // Used internally by AuthService because it needs password hash
  // ==========================================================

  async findOne(id: number): Promise<User> {
    const user = await this.prisma.user.findUnique({
      where: { id },
    });

    if (!user) {
      throw new NotFoundException(`Utilisateur #${id} introuvable.`);
    }

    return user;
  }

  // ==========================================================
  // 5. FIND ONE BY EMAIL
  // Used by login / forgot password
  // ==========================================================

  async findOneByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { email },
    });
  }

  // ==========================================================
  // 6. FIND ACTIVE USER BY ID
  // Used by JwtStrategy
  // ==========================================================

  async findActiveById(id: number) {
    return this.prisma.user.findFirst({
      where: {
        id,
        isActive: true,
        deletedAt: null,
      },
      select: this.safeUserSelect,
    });
  }

  // ==========================================================
  // 7. GET SAFE PROFILE
  // Used by /users/me and admin user detail
  // ==========================================================

  async getProfile(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: this.safeUserSelect,
    });

    if (!user || user.deletedAt) {
      throw new NotFoundException('Utilisateur introuvable.');
    }

    return user;
  }

  // ==========================================================
  // 8. UPDATE PROFILE
  // Used by user settings / profile page
  // ==========================================================

  async updateProfile(
    userId: number,
    updateData: {
      name?: string;
      email?: string;
      phone?: string;
      address?: string;
      taxId?: string;
      website?: string;
    },
  ) {
    const currentUser = await this.findOne(userId);

    if (currentUser.deletedAt) {
      throw new NotFoundException('Utilisateur introuvable.');
    }

    if (updateData.email) {
      updateData = { ...updateData, email: this.normalizeEmail(updateData.email) };
    }

    if (updateData.email && updateData.email !== currentUser.email) {
      const existingEmail = await this.prisma.user.findUnique({
        where: { email: updateData.email },
      });

      if (existingEmail) {
        throw new ConflictException('Cet email est déjà utilisé.');
      }
    }

    return this.prisma.user.update({
      where: { id: userId },
      data: {
        ...updateData,

        // If email changed, force email verification again
        emailVerifiedAt:
          updateData.email && updateData.email !== currentUser.email
            ? null
            : currentUser.emailVerifiedAt,

        // If phone changed, force phone verification again
        phoneVerifiedAt:
          updateData.phone && updateData.phone !== currentUser.phone
            ? null
            : currentUser.phoneVerifiedAt,
      },
      select: this.safeUserSelect,
    });
  }

  // ==========================================================
  // 9. ADMIN UPDATE USER
  // Used by admin dashboard
  // ==========================================================

  async updateByAdmin(
    id: number,
    data: {
      name?: string;
      email?: string;
      phone?: string;
      role?: Role;
      isActive?: boolean;
      address?: string;
      taxId?: string;
      website?: string;
    },
  ) {
    await this.findOne(id);

    if (data.email) {
      data = { ...data, email: this.normalizeEmail(data.email) };

      const existingEmail = await this.prisma.user.findFirst({
        where: {
          email: data.email,
          NOT: { id },
        },
      });

      if (existingEmail) {
        throw new ConflictException('Cet email est déjà utilisé.');
      }
    }

    return this.prisma.user.update({
      where: { id },
      data,
      select: this.safeUserSelect,
    });
  }

  // ==========================================================
  // 10. UPDATE PASSWORD
  // Used if needed outside AuthService
  // ==========================================================

  async updatePassword(id: number, newPassword: string): Promise<User> {
    await this.findOne(id);

    const hashedPassword = await argon2.hash(newPassword);

    return this.prisma.user.update({
      where: { id },
      data: {
        password: hashedPassword,
        passwordChangedAt: new Date(),
      },
    });
  }

  // ==========================================================
  // 11. UPDATE LOCATION GPS
  // Used by artisan mobile app
  // ==========================================================

  async updateLocation(id: number, latitude: number, longitude: number) {
    await this.findOne(id);

    return this.prisma.user.update({
      where: { id },
      data: {
        latitude,
        longitude,
      },
      select: this.safeUserSelect,
    });
  }

  // ==========================================================
  // 12. DEACTIVATE ACCOUNT
  // Soft delete + revoke refresh tokens
  // ==========================================================

  async deactivateAccount(id: number) {
    await this.findOne(id);

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id },
        data: {
          isActive: false,
          deletedAt: new Date(),
        },
      }),

      this.prisma.authToken.updateMany({
        where: {
          userId: id,
          type: AuthTokenType.REFRESH,
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
        },
      }),
    ]);

    return {
      message: 'Compte désactivé avec succès.',
    };
  }

  // ==========================================================
  // 13. REMOVE USER
  // Alias for deactivateAccount
  // ==========================================================

  async remove(id: number) {
    return this.deactivateAccount(id);
  }

  // ==========================================================
  // 14. CREATE ARTISAN DIRECTLY
  // Used by admin dashboard
  // No fixed password. The account gets a random unusable password and the
  // owner receives a one-time link to choose their own (P0-04).
  // ==========================================================

  async createArtisanDirectly(data: {
    name: string;
    email: string;
    phone: string;
    specialty?: string;
  }) {
    if (typeof data?.name !== 'string' || !data.name.trim()) {
      throw new BadRequestException('Le nom est obligatoire.');
    }

    data = { ...data, email: this.normalizeEmail(data.email) };

    const existingUser = await this.prisma.user.findUnique({
      where: { email: data.email },
    });

    if (existingUser) {
      throw new BadRequestException('Cet email est déjà utilisé.');
    }

    const temporaryPassword = this.generateTemporaryPassword();
    const hashedPassword = await argon2.hash(temporaryPassword);

    const user = await this.prisma.user.create({
      data: {
        name: data.name,
        email: data.email,
        phone: data.phone,
        password: hashedPassword,
        role: Role.ARTISAN,
        isActive: true,
      },
    });

    const passwordSetupUrl = await this.sendPasswordSetupLink(user);

    return {
      ...this.stripPassword(user),
      ...(passwordSetupUrl ? { passwordSetupUrl } : {}),
    };
  }

  // ==========================================================
  // 15. CREATE STAFF USER
  // Used later for SUPPORT / DISPATCHER / ACCOUNTANT / ADMIN
  // Same rule as artisans: random password + one-time set-password link.
  // ==========================================================

  async createStaffUser(data: {
    name: string;
    email: string;
    phone?: string;
    role: Role;
  }) {
    const allowedStaffRoles: Role[] = [
      Role.ADMIN,
      Role.SUPER_ADMIN,
      Role.SUPPORT,
      Role.DISPATCHER,
      Role.ACCOUNTANT,
    ];

    if (!allowedStaffRoles.includes(data.role)) {
      throw new BadRequestException('Rôle staff invalide.');
    }

    if (typeof data?.name !== 'string' || !data.name.trim()) {
      throw new BadRequestException('Le nom est obligatoire.');
    }

    data = { ...data, email: this.normalizeEmail(data.email) };

    const existingUser = await this.prisma.user.findUnique({
      where: { email: data.email },
    });

    if (existingUser) {
      throw new BadRequestException('Cet email est déjà utilisé.');
    }

    const temporaryPassword = this.generateTemporaryPassword();
    const hashedPassword = await argon2.hash(temporaryPassword);

    const user = await this.prisma.user.create({
      data: {
        name: data.name,
        email: data.email,
        phone: data.phone,
        password: hashedPassword,
        role: data.role,
        isActive: true,
      },
    });

    const passwordSetupUrl = await this.sendPasswordSetupLink(user);

    return {
      ...this.stripPassword(user),
      ...(passwordSetupUrl ? { passwordSetupUrl } : {}),
    };
  }

  // ==========================================================
  // 16. REACTIVATE USER
  // Used by admin dashboard
  // ==========================================================

  async reactivateUser(id: number) {
    await this.findOne(id);

    return this.prisma.user.update({
      where: { id },
      data: {
        isActive: true,
        deletedAt: null,
      },
      select: this.safeUserSelect,
    });
  }

  // ==========================================================
  // 17. PRIVATE HELPER
  // ==========================================================

  private generateTemporaryPassword(): string {
    return `Temp-${crypto.randomBytes(32).toString('hex')}A1`;
  }

  private stripPassword(user: User) {
    const { password, ...safeUser } = user;
    return safeUser;
  }

  /**
   * Issues a new one-time "choose your password" link for an existing account
   * (the first one was lost, or expired after 24 hours). The previous unused
   * link is revoked. Only for accounts that can log in.
   */
  async reissuePasswordSetupLink(userId: number) {
    const user = await this.findOne(userId);

    if (user.deletedAt || !user.isActive || user.isGuest) {
      throw new BadRequestException(
        "Ce compte est désactivé ou n'est pas un compte complet : impossible de créer un lien.",
      );
    }

    const passwordSetupUrl = await this.sendPasswordSetupLink(user);

    return passwordSetupUrl
      ? { message: 'Nouveau lien créé (24 h, usage unique).', passwordSetupUrl }
      : { message: 'Un nouveau lien a été envoyé par email.' };
  }

  private normalizeEmail(email: string): string {
    // Some admin routes take an inline body type, which the global
    // ValidationPipe does not check: refuse anything that is not an address.
    if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      throw new BadRequestException('Adresse email invalide.');
    }

    return email.trim().toLowerCase();
  }

  /**
   * Sends the one-time "choose your password" link.
   *
   * E-mail delivery is still simulated (NotificationsService), so the mail
   * would never arrive. While that is true the link is also returned to the
   * staff member who created the account, who hands it over in person or by
   * message. The caller is always an authenticated back-office user.
   */
  private async sendPasswordSetupLink(user: User): Promise<string | undefined> {
    const setupUrl = await issuePasswordSetupLink(this.prisma, user.id);

    await this.notifications.sendEmail(
      user.email,
      'Création de votre mot de passe',
      `Votre compte Smart Dépannage a été créé. Choisissez votre mot de passe ` +
        `(lien valable 24 heures, usage unique) : ${setupUrl}`,
    );

    return this.notifications.isEmailSimulated() ? setupUrl : undefined;
  }
}
