import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import * as crypto from 'crypto';

import { UsersService } from '../users/users.service';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  getFrontendUrl as getConfiguredFrontendUrl,
  getJwtAccessSecret,
  getJwtRefreshSecret,
} from '../../config/env';
import {
  RATE_RULES,
  RateLimitService,
} from '../../common/rate-limit/rate-limit.service';
import { generateUnusablePassword } from './password-setup';
import { deliveryAnswer } from '../notifications/delivery/delivery-answer';
import {
  phoneColumns,
  phoneWhere,
} from '../../common/contact/phone';
import { isMadeUpGuestEmail } from '../notifications/delivery/contact';
import {
  generateSixDigitCode,
  hashOneTimeCode,
} from '../../common/auth/one-time-code';

import {
  AuthTokenType,
  Role,
  User,
} from '../../../generated/prisma/client';

/** A change of e-mail or phone that is waiting for its link or code. */
const PENDING_CONTACT_CHANGES = [
  AuthTokenType.EMAIL_CHANGE,
  AuthTokenType.PHONE_CHANGE,
];

/** `code` of the 409 that tells an app to open the guest activation screen. */
export const GUEST_PROFILE_EXISTS = 'GUEST_PROFILE_EXISTS';

type AccessTokenPayload = {
  sub: number;
  email: string;
  role: Role;
  tokenType: 'access';
};

type RefreshTokenPayload = {
  sub: number;
  email: string;
  role: Role;
  tokenId: number;
  tokenType: 'refresh';
};

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /**
   * Hash verified when the email is unknown, so "no such account" and "wrong
   * password" take the same time. Built lazily with the same argon2 settings
   * as real hashes.
   */
  private dummyPasswordHash?: Promise<string>;

  private getDummyPasswordHash(): Promise<string> {
    this.dummyPasswordHash ??= argon2.hash(generateUnusablePassword());
    return this.dummyPasswordHash;
  }

  // ==========================================================
  // 1. HELPERS
  // ==========================================================

  private removePassword(user: User) {
    const { password, ...safeUser } = user;
    return safeUser;
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private generateRandomToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  private getFrontendUrl(): string {
    return getConfiguredFrontendUrl();
  }

  private isGeneratedGuestEmail(email: string): boolean {
    return isMadeUpGuestEmail(email);
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private normalizePhone(phone?: string): string | undefined {
    return phone?.trim() || undefined;
  }

  private getAccessTokenExpiration(): JwtSignOptions['expiresIn'] {
    return (process.env.JWT_ACCESS_EXPIRES_IN ||
      '15m') as JwtSignOptions['expiresIn'];
  }

  private getRefreshTokenExpiration(): JwtSignOptions['expiresIn'] {
    return (process.env.JWT_REFRESH_EXPIRES_IN ||
      '7d') as JwtSignOptions['expiresIn'];
  }

  private getRefreshTokenExpirationDate(): Date {
    const expiresIn = process.env.JWT_REFRESH_EXPIRES_IN || '7d';

    const match = expiresIn.match(/^(\d+)(s|m|h|d)$/);

    if (!match) {
      return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    }

    const amount = Number(match[1]);
    const unit = match[2];

    const multiplier =
      unit === 's'
        ? 1000
        : unit === 'm'
          ? 60 * 1000
          : unit === 'h'
            ? 60 * 60 * 1000
            : 24 * 60 * 60 * 1000;

    return new Date(Date.now() + amount * multiplier);
  }

  // ==========================================================
  // 2. CREATE TOKENS
  // ==========================================================

  private async createAccessToken(user: User): Promise<string> {
    const payload: AccessTokenPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      tokenType: 'access',
    };

    const options: JwtSignOptions = {
      secret: getJwtAccessSecret(),
      expiresIn: this.getAccessTokenExpiration(),
    };

    return this.jwtService.signAsync(payload, options);
  }

  private async createRefreshToken(user: User): Promise<string> {
    const expiresAt = this.getRefreshTokenExpirationDate();

    const tempHash = `pending_${crypto.randomUUID()}`;

    const tokenRecord = await this.prisma.authToken.create({
      data: {
        userId: user.id,
        type: AuthTokenType.REFRESH,
        tokenHash: tempHash,
        expiresAt,
      },
    });

    const payload: RefreshTokenPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      tokenId: tokenRecord.id,
      tokenType: 'refresh',
    };

    const options: JwtSignOptions = {
      secret: getJwtRefreshSecret(),
      expiresIn: this.getRefreshTokenExpiration(),
    };

    const refreshToken = await this.jwtService.signAsync(payload, options);

    await this.prisma.authToken.update({
      where: { id: tokenRecord.id },
      data: {
        tokenHash: this.hashToken(refreshToken),
      },
    });

    return refreshToken;
  }

  private async createTokenPair(user: User) {
    const accessToken = await this.createAccessToken(user);
    const refreshToken = await this.createRefreshToken(user);

    return {
      accessToken,
      refreshToken,
      user: this.removePassword(user),
    };
  }

  private async createOneTimeToken(
    userId: number,
    type: AuthTokenType,
    expiresInMs: number,
  ): Promise<string> {
    const rawToken = this.generateRandomToken();

    await this.prisma.authToken.updateMany({
      where: {
        userId,
        type,
        usedAt: null,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });

    await this.prisma.authToken.create({
      data: {
        userId,
        type,
        tokenHash: this.hashToken(rawToken),
        expiresAt: new Date(Date.now() + expiresInMs),
      },
    });

    return rawToken;
  }

  // ==========================================================
  // 3. VALIDATE USER
  // Used by login and LocalStrategy if you use one
  // ==========================================================

  async validateUser(email: string, pass: string): Promise<any> {
    const user = await this.usersService.findOneByEmail(
      this.normalizeEmail(email),
    );

    if (!user) {
      return null;
    }

    // Guest profiles have an unusable random password.
    // They must activate their account first.
    if (user.isGuest) {
      return null;
    }

    if (!user.isActive || user.deletedAt) {
      return null;
    }

    const isPasswordValid = await argon2.verify(user.password, pass);

    if (!isPasswordValid) {
      return null;
    }

    return this.removePassword(user);
  }

  // ==========================================================
  // 4. REGISTER
  // Creates a normal client account. It never takes over an existing guest
  // profile (P0-09): that needs the one-time code flow of GuestService.
  // ==========================================================

  async register(userDto: {
    email: string;
    password: string;
    name?: string;
    phone?: string;
  }) {
    const normalizedEmail = this.normalizeEmail(userDto.email);
    const normalizedPhone = this.normalizePhone(userDto.phone);

    // 400 when the number cannot be a phone number; the canonical key is what
    // makes "22 123 456" and "+216 22123456" the same number.
    const phone = phoneColumns(normalizedPhone);

    const matches = await this.prisma.user.findMany({
      where: {
        OR: [
          { email: normalizedEmail },
          phoneWhere(normalizedPhone),
        ].filter(Boolean) as any[],
      },
    });

    const samePhone = (candidate: { phone: string | null; phoneKey: string | null }) =>
      Boolean(phone.phoneKey) &&
      (candidate.phoneKey === phone.phoneKey || candidate.phone === phone.phone);

    // Case 1: normal user already exists
    const existingUser = matches.find((candidate) => !candidate.isGuest);

    if (existingUser) {
      if (existingUser.email === normalizedEmail) {
        throw new ConflictException('Cet email est déjà utilisé.');
      }

      if (samePhone(existingUser)) {
        throw new ConflictException(
          'Ce numéro de téléphone est déjà utilisé.',
        );
      }

      throw new ConflictException('Un compte existe déjà.');
    }

    // Case 2: a guest profile already uses this e-mail or this phone number.
    //
    // P0-09: registering must NOT convert the guest profile. Anyone who knew
    // (or guessed) a guest's e-mail or number could otherwise register with it
    // and take over the profile, including its interventions, addresses and
    // tracking links. The conversion needs proof of ownership, through the
    // one-time code flow of GuestService (POST /guest/account/request-activation,
    // then POST /guest/account/activate): the code goes to the guest's own
    // phone, the link to the guest's own mailbox (P1-03, step 4).
    //
    // A phone number now belongs to one account, so a guest holding the number
    // also blocks it here. `code` lets an app send the person to the activation
    // screen; the answer does not say which of the two details matched.
    if (
      matches.some(
        (candidate) =>
          candidate.isGuest &&
          !candidate.deletedAt &&
          (candidate.email === normalizedEmail || samePhone(candidate)),
      )
    ) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: GUEST_PROFILE_EXISTS,
        message:
          'Un profil invité existe déjà avec ces coordonnées. ' +
          'Activez-le avec le code reçu pour définir votre mot de passe.',
      });
    }

    // Case 3: totally new user
    const user = await this.usersService.create({
      email: normalizedEmail,
      password: userDto.password,
      name: userDto.name,
      phone: normalizedPhone,
      role: Role.CLIENT,
      isGuest: false,
    });

    await this.sendEmailVerification(user.id);

    return this.createTokenPair(user);
  }

  // ==========================================================
  // 5. LOGIN
  // Compatible with your old frontend style:
  // login(user) if controller already validated user
  // OR login(email, password) if controller sends credentials
  // ==========================================================

  async login(userOrEmail: any, password?: string, clientIp?: string) {
    let user: User | null = null;

    // Case 1: login(email, password)
    if (typeof userOrEmail === 'string') {
      const normalizedEmail = this.normalizeEmail(userOrEmail);
      const accountKey = `login:${normalizedEmail}`;
      const clientKey = `login:${normalizedEmail}:${clientIp ?? 'unknown'}`;

      // P0-07: after 5 wrong passwords from one address, that address is locked
      // out of the account for 15 minutes (a correct password is refused too).
      // 30 wrong passwords from many addresses lock the account itself.
      this.rateLimit.assertNotLocked(clientKey);
      this.rateLimit.assertNotLocked(accountKey);

      const found = await this.usersService.findOneByEmail(normalizedEmail);

      // Always run one argon2 verification so the response time does not tell
      // an attacker whether the email exists.
      const hashToCheck = found?.password ?? (await this.getDummyPasswordHash());
      const isPasswordValid = await argon2
        .verify(hashToCheck, password || '')
        .catch(() => false);

      if (!found || !isPasswordValid) {
        this.rateLimit.registerFailure(clientKey, RATE_RULES.loginFailuresPerClient);
        this.rateLimit.registerFailure(accountKey, RATE_RULES.loginFailuresPerAccount);
        throw new UnauthorizedException('Email ou mot de passe incorrect.');
      }

      // Account state is only disclosed to someone who knows the password.
      if (found.isGuest) {
        throw new UnauthorizedException(
          'Veuillez activer votre compte avant de vous connecter.',
        );
      }

      if (!found.isActive || found.deletedAt) {
        throw new UnauthorizedException('Compte désactivé.');
      }

      this.rateLimit.clear(clientKey);
      this.rateLimit.clear(accountKey);
      user = found;
    }

    // Case 2: login(user)
    else {
      const fullUser = await this.usersService.findOne(userOrEmail.id);

      if (fullUser.isGuest) {
        throw new UnauthorizedException(
          'Veuillez activer votre compte avant de vous connecter.',
        );
      }

      if (!fullUser.isActive || fullUser.deletedAt) {
        throw new UnauthorizedException('Compte désactivé.');
      }

      user = fullUser;
    }

    return this.createTokenPair(user);
  }

  // ==========================================================
  // 6. REFRESH TOKEN
  // ==========================================================

  async refresh(refreshToken: string) {
    let payload: RefreshTokenPayload;

    try {
      payload = await this.jwtService.verifyAsync<RefreshTokenPayload>(
        refreshToken,
        {
          secret: getJwtRefreshSecret(),
        },
      );
    } catch {
      throw new UnauthorizedException('Refresh token invalide.');
    }

    if (payload.tokenType !== 'refresh') {
      throw new UnauthorizedException('Token invalide.');
    }

    const tokenRecord = await this.prisma.authToken.findUnique({
      where: { id: payload.tokenId },
      include: { user: true },
    });

    if (!tokenRecord) {
      throw new UnauthorizedException('Session introuvable.');
    }

    if (tokenRecord.type !== AuthTokenType.REFRESH) {
      throw new UnauthorizedException('Token invalide.');
    }

    if (tokenRecord.userId !== payload.sub) {
      throw new UnauthorizedException('Token invalide.');
    }

    if (tokenRecord.usedAt || tokenRecord.revokedAt) {
      throw new UnauthorizedException('Session expirée.');
    }

    if (tokenRecord.expiresAt < new Date()) {
      throw new UnauthorizedException('Session expirée.');
    }

    if (tokenRecord.tokenHash !== this.hashToken(refreshToken)) {
      throw new UnauthorizedException('Token invalide.');
    }

    if (tokenRecord.user.isGuest) {
      throw new UnauthorizedException(
        'Veuillez activer votre compte avant de vous connecter.',
      );
    }

    if (!tokenRecord.user.isActive || tokenRecord.user.deletedAt) {
      throw new UnauthorizedException('Compte désactivé.');
    }

    // Refresh token rotation: old refresh token becomes invalid
    await this.prisma.authToken.update({
      where: { id: tokenRecord.id },
      data: {
        usedAt: new Date(),
        revokedAt: new Date(),
      },
    });

    return this.createTokenPair(tokenRecord.user);
  }

  // ==========================================================
  // 7. LOGOUT
  // ==========================================================

  async logout(refreshToken: string) {
    try {
      const payload = await this.jwtService.verifyAsync<RefreshTokenPayload>(
        refreshToken,
        {
          secret: getJwtRefreshSecret(),
        },
      );

      await this.prisma.authToken.updateMany({
        where: {
          id: payload.tokenId,
          userId: payload.sub,
          type: AuthTokenType.REFRESH,
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
        },
      });
    } catch {
      // We do not reveal if the token was valid or not.
    }

    return {
      message: 'Déconnexion réussie.',
    };
  }

  // ==========================================================
  // 8. LOGOUT EVERYWHERE
  // ==========================================================

  async logoutEverywhere(userId: number) {
    await this.prisma.authToken.updateMany({
      where: {
        userId,
        type: { in: [AuthTokenType.REFRESH, ...PENDING_CONTACT_CHANGES] },
        usedAt: null,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });

    return {
      message: 'Déconnexion de tous les appareils réussie.',
    };
  }

  // ==========================================================
  // 9. FORGOT PASSWORD
  // ==========================================================

  async forgotPassword(email: string) {
    const normalizedEmail = this.normalizeEmail(email);

    // P0-07: at most 3 reset mails per address per hour. Over the limit we
    // answer exactly as if nothing were wrong, so the limit itself does not
    // reveal whether the account exists.
    const withinLimit = this.rateLimit.tryConsume(
      `forgot:${normalizedEmail}`,
      RATE_RULES.forgotPasswordPerEmail,
    );

    const user = withinLimit
      ? await this.usersService.findOneByEmail(normalizedEmail)
      : null;

    if (!user || !user.isActive || user.deletedAt || user.isGuest) {
      return {
        message:
          'Si un compte existe avec cet email, un lien de réinitialisation a été envoyé.',
      };
    }

    const rawToken = await this.createOneTimeToken(
      user.id,
      AuthTokenType.PASSWORD_RESET,
      60 * 60 * 1000,
    );

    const resetUrl = `${this.getFrontendUrl()}/reset-password?token=${rawToken}`;

    await this.notificationsService.sendEmail(
      user.email,
      'Réinitialisation de votre mot de passe',
      `Cliquez sur ce lien pour réinitialiser votre mot de passe: ${resetUrl}`,
      {
        userId: user.id,
        template: { key: 'auth.password_reset', vars: { name: user.name, link: resetUrl } },
        // Same life as the token (1 h); a new request revokes the old token, so its message must not go out either.
        validForMs: 60 * 60 * 1000,
        replaces: `auth:PASSWORD_RESET:${user.id}`,
      },
    );

    return {
      message:
        'Si un compte existe avec cet email, un lien de réinitialisation a été envoyé.',
    };
  }

  // ==========================================================
  // 10. RESET PASSWORD
  // ==========================================================

  async resetPassword(token: string, newPassword: string) {
    const tokenHash = this.hashToken(token);

    const tokenRecord = await this.prisma.authToken.findFirst({
      where: {
        tokenHash,
        type: AuthTokenType.PASSWORD_RESET,
        usedAt: null,
        revokedAt: null,
        expiresAt: {
          gt: new Date(),
        },
      },
      include: {
        user: true,
      },
    });

    if (!tokenRecord) {
      throw new BadRequestException('Token invalide ou expiré.');
    }

    if (tokenRecord.user.isGuest) {
      throw new BadRequestException(
        'Veuillez activer votre compte invité avant de définir un mot de passe.',
      );
    }

    const hashedPassword = await argon2.hash(newPassword);

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: tokenRecord.userId },
        data: {
          password: hashedPassword,
          passwordChangedAt: new Date(),
        },
      }),

      this.prisma.authToken.update({
        where: { id: tokenRecord.id },
        data: {
          usedAt: new Date(),
          revokedAt: new Date(),
        },
      }),

      this.prisma.authToken.updateMany({
        where: {
          userId: tokenRecord.userId,
          // Sessions end, and so does a contact change somebody started with the old
          // password: its link or code must not finish after the owner took the account back.
          type: { in: [AuthTokenType.REFRESH, ...PENDING_CONTACT_CHANGES] },
          usedAt: null,
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
        },
      }),
    ]);

    return {
      message: 'Mot de passe réinitialisé avec succès.',
    };
  }

  // ==========================================================
  // 11. CHANGE PASSWORD
  // ==========================================================

  async changePassword(
    userId: number,
    currentPassword: string,
    newPassword: string,
  ) {
    const user = await this.usersService.findOne(userId);

    if (user.isGuest) {
      throw new BadRequestException(
        'Veuillez activer votre compte avant de modifier le mot de passe.',
      );
    }

    if (!user.isActive || user.deletedAt) {
      throw new UnauthorizedException('Compte désactivé.');
    }

    // A stolen session must not be able to guess the current password at machine speed.
    const lockKey = `password-confirm:${user.id}`;

    this.rateLimit.assertNotLocked(lockKey);
    // Counted before the slow check: requests sent at once must not all pass the lock test.
    this.rateLimit.registerFailure(lockKey, RATE_RULES.passwordConfirmFailures);

    const isPasswordValid = await argon2.verify(
      user.password,
      currentPassword,
    );

    if (!isPasswordValid) {
      throw new BadRequestException('Mot de passe actuel incorrect.');
    }

    this.rateLimit.clear(lockKey);

    const hashedPassword = await argon2.hash(newPassword);

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: {
          password: hashedPassword,
          passwordChangedAt: new Date(),
        },
      }),

      this.prisma.authToken.updateMany({
        where: {
          userId,
          type: { in: [AuthTokenType.REFRESH, ...PENDING_CONTACT_CHANGES] },
          usedAt: null,
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
        },
      }),
    ]);

    return {
      message:
        'Mot de passe modifié avec succès. Veuillez vous reconnecter.',
    };
  }

  // ==========================================================
  // 12. SEND EMAIL VERIFICATION
  // ==========================================================

  async sendEmailVerification(userId: number) {
    const user = await this.usersService.findOne(userId);

    if (user.isGuest) {
      return {
        message:
          'Compte invité non activé. Veuillez activer le compte avant la vérification email.',
      };
    }

    if (this.isGeneratedGuestEmail(user.email)) {
      throw new BadRequestException(
        'Impossible de vérifier un email invité généré automatiquement.',
      );
    }

    if (user.emailVerifiedAt) {
      return {
        message: 'Email déjà vérifié.',
      };
    }

    this.rateLimit.assertWithin(
      `code-send:email:${user.id}`,
      RATE_RULES.codeSendPerTarget,
    );

    const rawToken = await this.createOneTimeToken(
      user.id,
      AuthTokenType.EMAIL_VERIFICATION,
      24 * 60 * 60 * 1000,
    );

    const verifyUrl = `${this.getFrontendUrl()}/verify-email?token=${rawToken}`;

    const queued = await this.notificationsService.sendEmail(
      user.email,
      'Vérification de votre email',
      `Cliquez sur ce lien pour vérifier votre email: ${verifyUrl}`,
      {
        userId: user.id,
        template: { key: 'auth.email_verification', vars: { name: user.name, link: verifyUrl } },
        validForMs: 24 * 60 * 60 * 1000,
        replaces: `auth:EMAIL_VERIFICATION:${user.id}`,
      },
    );

    return this.deliveryAnswer(
      queued,
      this.notificationsService.isEmailSimulated(),
      'email',
      'Email de vérification envoyé.',
    );
  }

  /** See delivery-answer.ts: the answer to "was the message sent?". */
  private deliveryAnswer(
    result: { queued: boolean },
    notConfigured: boolean,
    kind: 'email' | 'sms',
    okMessage: string,
  ) {
    return deliveryAnswer(result, notConfigured, kind, okMessage);
  }

  // ==========================================================
  // 13. VERIFY EMAIL
  // ==========================================================

  async verifyEmail(token: string) {
    const tokenRecord = await this.prisma.authToken.findFirst({
      where: {
        tokenHash: this.hashToken(token),
        type: AuthTokenType.EMAIL_VERIFICATION,
        usedAt: null,
        revokedAt: null,
        expiresAt: {
          gt: new Date(),
        },
      },
      include: {
        user: true,
      },
    });

    if (!tokenRecord) {
      throw new BadRequestException('Token invalide ou expiré.');
    }

    if (tokenRecord.user.isGuest) {
      throw new BadRequestException(
        'Veuillez activer votre compte invité avant la vérification email.',
      );
    }

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: tokenRecord.userId },
        data: {
          emailVerifiedAt: new Date(),
        },
      }),

      this.prisma.authToken.update({
        where: { id: tokenRecord.id },
        data: {
          usedAt: new Date(),
          revokedAt: new Date(),
        },
      }),
    ]);

    return {
      message: 'Email vérifié avec succès.',
    };
  }

  // ==========================================================
  // 14. SEND PHONE VERIFICATION CODE
  // ==========================================================

  async sendPhoneVerification(userId: number) {
    const user = await this.usersService.findOne(userId);

    if (user.isGuest) {
      throw new BadRequestException(
        'Veuillez activer votre compte avant la vérification téléphone.',
      );
    }

    if (!user.phone) {
      throw new BadRequestException(
        'Ajoutez un numéro de téléphone avant la vérification.',
      );
    }

    if (user.phoneVerifiedAt) {
      return {
        message: 'Téléphone déjà vérifié.',
      };
    }

    // P0-07: limit how many SMS one user can trigger (cost and spam).
    this.rateLimit.assertWithin(
      `code-send:phone:${userId}`,
      RATE_RULES.codeSendPerTarget,
    );

    const code = generateSixDigitCode();

    await this.prisma.authToken.updateMany({
      where: {
        userId,
        type: AuthTokenType.PHONE_VERIFICATION,
        usedAt: null,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });

    await this.prisma.authToken.create({
      data: {
        userId,
        type: AuthTokenType.PHONE_VERIFICATION,
        tokenHash: hashOneTimeCode(userId, 'phone-verification', code),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    const queued = await this.notificationsService.sendSms(
      user.phone,
      `Votre code de vérification est: ${code}`,
      {
        userId: user.id,
        template: { key: 'auth.phone_code', vars: { name: user.name, code } },
        // The code lives 10 minutes; asking again cancels the previous one, so a
        // gateway coming back after an outage never delivers a pile of dead codes.
        validForMs: 10 * 60 * 1000,
        replaces: `auth:PHONE_VERIFICATION:${user.id}`,
      },
    );

    return this.deliveryAnswer(
      queued,
      this.notificationsService.isSmsSimulated(),
      'sms',
      'Code de vérification envoyé par SMS.',
    );
  }

  // ==========================================================
  // 15. VERIFY PHONE
  // ==========================================================

  async verifyPhone(userId: number, code: string) {
    // P0-07: a 6 digit code must not be guessable by trying all of them.
    const lockKey = `otp:phone:${userId}`;
    this.rateLimit.assertNotLocked(lockKey);
    // Counted before the lookup, cleared when the code is right: requests sent at
    // once must not all pass the lock test before the first failure is written down.
    this.rateLimit.registerFailure(lockKey, RATE_RULES.otpFailures);

    const user = await this.usersService.findOne(userId);

    if (user.isGuest) {
      throw new BadRequestException(
        'Veuillez activer votre compte avant la vérification téléphone.',
      );
    }

    const tokenRecord = await this.prisma.authToken.findFirst({
      where: {
        userId,
        tokenHash: hashOneTimeCode(userId, 'phone-verification', code),
        type: AuthTokenType.PHONE_VERIFICATION,
        usedAt: null,
        revokedAt: null,
        expiresAt: {
          gt: new Date(),
        },
      },
    });

    if (!tokenRecord) {
      throw new BadRequestException('Code invalide ou expiré.');
    }

    this.rateLimit.clear(lockKey);

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: {
          phoneVerifiedAt: new Date(),
        },
      }),

      this.prisma.authToken.update({
        where: { id: tokenRecord.id },
        data: {
          usedAt: new Date(),
          revokedAt: new Date(),
        },
      }),
    ]);

    return {
      message: 'Téléphone vérifié avec succès.',
    };
  }

  // ==========================================================
  // 16. SEND PASSWORD SETUP EMAIL
  // Used when admin approves artisan or creates staff account
  // ==========================================================

  async sendPasswordSetupEmail(userId: number) {
    const user = await this.usersService.findOne(userId);

    if (user.isGuest) {
      throw new BadRequestException(
        'Un compte invité doit être activé avec le flux invité, pas avec la création de mot de passe admin.',
      );
    }

    if (this.isGeneratedGuestEmail(user.email)) {
      throw new BadRequestException(
        'Impossible d’envoyer un email à une adresse invitée générée automatiquement.',
      );
    }

    const rawToken = await this.createOneTimeToken(
      user.id,
      AuthTokenType.PASSWORD_RESET,
      24 * 60 * 60 * 1000,
    );

    const setupUrl = `${this.getFrontendUrl()}/reset-password?token=${rawToken}`;

    const queued = await this.notificationsService.sendEmail(
      user.email,
      'Création de votre mot de passe',
      `Votre compte a été créé. Cliquez ici pour créer votre mot de passe: ${setupUrl}`,
      {
        userId: user.id,
        template: { key: 'auth.password_setup', vars: { name: user.name, link: setupUrl } },
        validForMs: 24 * 60 * 60 * 1000,
        // Setup links are password-reset tokens: a newer one revokes the older one.
        replaces: `auth:PASSWORD_RESET:${user.id}`,
      },
    );

    return this.deliveryAnswer(
      queued,
      this.notificationsService.isEmailSimulated(),
      'email',
      'Email de création de mot de passe envoyé.',
    );
  }
}
