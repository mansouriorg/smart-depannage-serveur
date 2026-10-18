import { paginated } from '../../common/api-contract/envelope';
import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { issuePasswordSetupLink } from '../auth/password-setup';
import {
  ContactChangeService,
  contactChangeRequired,
} from './contact-change.service';
import {
  PHONE_TAKEN_MESSAGE,
  phoneColumns,
  phoneKeyOf,
  phoneWhere,
  rethrowContactConflict,
} from '../../common/contact/phone';
import { ARTISAN_LIST_PROFILE_SELECT, artisanFeedback } from './artisan-list-filter';
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
    private readonly contactChange: ContactChangeService,
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

    // One phone number, one account (the database enforces it too).
    const phoneCols = await this.claimPhone(data.phone);

    if (!data.password || typeof data.password !== 'string') {
      throw new BadRequestException('Le mot de passe est obligatoire.');
    }

    const hashedPassword = await argon2.hash(data.password);

    try {
      return await this.prisma.user.create({
        data: {
          ...data,
          ...phoneCols,
          password: hashedPassword,
          isActive: true,
        },
      });
    } catch (error) {
      rethrowContactConflict(error);
    }
  }

  /**
   * The phone columns to write for a new account, after checking that nobody
   * else has the number. `{}` when no number was given (the column is left alone).
   */
  private async claimPhone(raw: string | null | undefined) {
    if (raw === undefined) return {};

    const columns = phoneColumns(raw);

    if (columns.phoneKey) {
      const holder = await this.prisma.user.findFirst({
        where: phoneWhere(columns.phone),
        select: { id: true },
      });

      if (holder) {
        throw new ConflictException(PHONE_TAKEN_MESSAGE);
      }
    }

    return columns;
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
    select?: Prisma.UserSelect;
  }) {
    const page = params?.page || 1;
    const limit = params?.limit || 20;
    const skip = (page - 1) * limit;

    const where = params?.where || {};

    const [data, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: params?.select ?? this.safeUserSelect,
        orderBy: { id: 'desc' },
        skip,
        take: limit,
      }),

      this.prisma.user.count({
        where,
      }),
    ]);

    return paginated(data, page, limit, total);
  }

  // ==========================================================
  // 3b. FIND ARTISANS (the technicians page, the assignment dropdown)
  // The account as everywhere (never the password), plus the trade and the rating of the profile, and
  // what customers answered after their jobs (`feedback`): the profile's rating counts the reviews a
  // moderator approved, and nothing in the dashboard approves them yet, so alone it would say "not rated" for everybody.
  // ==========================================================

  async findArtisans(params: { where: Prisma.UserWhereInput; page?: number; limit?: number }) {
    const page = await this.findAll({
      ...params,
      select: { ...this.safeUserSelect, artisanProfile: { select: ARTISAN_LIST_PROFILE_SELECT } },
    });

    const ids = (page.data as Array<{ id: number }>).map((row) => row.id);

    if (ids.length === 0) return page;

    // Typed by hand: Prisma's own type for a grouped query is a conditional one that depends on every option.
    const groups = (await this.prisma.intervention.groupBy({
      by: ['artisanId'],
      where: { artisanId: { in: ids }, rating: { not: null } },
      _avg: { rating: true },
      _count: { rating: true },
    })) as unknown as Array<{ artisanId: number | null; _avg: { rating: number | null }; _count: { rating: number } }>;

    const feedbackOf = new Map(groups.map((group) => [group.artisanId, group]));

    return {
      ...page,
      data: (page.data as Array<{ id: number }>).map((row) => {
        const group = feedbackOf.get(row.id);

        return { ...row, feedback: artisanFeedback(group?._avg.rating, group?._count.rating) };
      }),
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

    // P1-03 (step 4): the e-mail and the phone are how a person gets back into
    // the account, so they change only through the routes that ask for the
    // current password and for proof that the new value is theirs. Sending the
    // value the account already has (an app that posts the whole form) is fine.
    const { email, phone, ...rest } = updateData;
    const data: Record<string, unknown> = { ...rest };

    if (email !== undefined && email !== null) {
      if (this.normalizeEmail(email) !== currentUser.email) {
        throw contactChangeRequired('email');
      }
    }

    if (phone !== undefined) {
      const asked = phoneKeyOf(phone);
      const typed = String(phone ?? '').trim();
      const current = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { phone: true, phoneKey: true },
      });
      const currentKey = current?.phoneKey ?? phoneKeyOf(current?.phone);

      if (!typed) {
        // Nothing to remove is fine; removing the number is a contact change like the others.
        if (current?.phone) {
          throw contactChangeRequired('phone');
        }
      } else if (asked && asked === currentKey) {
        // Same number, maybe written differently: nothing to change.
      } else if (typed !== current?.phone) {
        throw contactChangeRequired('phone');
      }
    }

    return this.prisma.user.update({
      where: { id: userId },
      data,
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
    options: { actorId?: number } = {},
  ) {
    const current = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, name: true, email: true, phone: true, phoneKey: true },
    });

    // Deleted accounts can still be corrected by staff (to free a number, say).
    if (!current) {
      throw new NotFoundException('Utilisateur introuvable.');
    }

    const { email, phone, ...rest } = data;

    // Staff correct other people's contact details (a customer who lost the
    // mailbox cannot prove anything). Their own go through the self-service
    // routes: the password check would otherwise be one PATCH away.
    const change = await this.contactChange.prepareAdminChange(current, { email, phone });

    if (options.actorId === id && (change.emailChangedFrom || change.phoneChangedFrom !== undefined)) {
      throw contactChangeRequired(change.emailChangedFrom ? 'email' : 'phone');
    }

    // The change and the end of the links that went to the old address or number are
    // one step: either both happen or neither does.
    const updated = await this.prisma
      .$transaction(async (tx) => {
        const row = await tx.user.update({
          where: { id },
          data: { ...rest, ...change.data },
          select: this.safeUserSelect,
        });

        await this.contactChange.revokeAfterAdminChange(tx, id, change);

        return row;
      })
      .catch(rethrowContactConflict);

    await this.contactChange.noticeAfterAdminChange(current, change, updated);

    return updated;
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
          // The number is free again (a person who deletes their account can come back
          // with it); the text stays on the row for the records.
          phoneKey: null,
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

    const phoneCols = await this.claimPhone(data.phone);

    const temporaryPassword = this.generateTemporaryPassword();
    const hashedPassword = await argon2.hash(temporaryPassword);

    const user = await this.prisma.user
      .create({
        data: {
          name: data.name,
          email: data.email,
          ...phoneCols,
          password: hashedPassword,
          role: data.role,
          isActive: true,
        },
      })
      .catch(rethrowContactConflict);

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
    const user = await this.findOne(id);

    // Take the number back if nobody has it in the meantime; otherwise the account
    // comes back without a key and staff sort the number out.
    let phoneKey: string | null = null;

    if (user.phone && user.phoneKey === null) {
      const key = phoneKeyOf(user.phone);
      const holder = key
        ? await this.prisma.user.findFirst({
            where: { phoneKey: key, NOT: { id } },
            select: { id: true },
          })
        : null;

      phoneKey = key && !holder ? key : null;
    }

    return this.prisma.user
      .update({
        where: { id },
        data: {
          isActive: true,
          deletedAt: null,
          ...(phoneKey ? { phoneKey } : {}),
        },
        select: this.safeUserSelect,
      })
      .catch(rethrowContactConflict);
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
   * While no mail server is configured (SMTP_HOST is empty) the mail cannot
   * arrive. In that case the link is also returned to the staff member who
   * created the account, who hands it over in person or by message. The caller
   * is always an authenticated back-office user.
   */
  private async sendPasswordSetupLink(user: User): Promise<string | undefined> {
    const setupUrl = await issuePasswordSetupLink(this.prisma, user.id);

    await this.notifications.sendEmail(
      user.email,
      'Création de votre mot de passe',
      `Votre compte Smart Dépannage a été créé. Choisissez votre mot de passe ` +
        `(lien valable 24 heures, usage unique) : ${setupUrl}`,
      {
        userId: user.id,
        template: { key: 'auth.password_setup', vars: { name: user.name, link: setupUrl } },
        validForMs: 24 * 60 * 60 * 1000,
        replaces: `auth:PASSWORD_RESET:${user.id}`,
      },
    );

    return this.notifications.isEmailSimulated() ? setupUrl : undefined;
  }
}
