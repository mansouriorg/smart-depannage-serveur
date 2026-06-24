import {
  BadRequestException,
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
  AuthTokenType,
  Role,
  User,
} from '../../../generated/prisma/client';

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
  ) {}

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

  private generatePhoneCode(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  private getFrontendUrl(): string {
    return process.env.FRONTEND_URL || 'http://localhost:3000';
  }

  // ✅ Important fix:
  // expiresIn must be typed as JwtSignOptions['expiresIn'], not normal string.
  private getAccessTokenExpiration(): JwtSignOptions['expiresIn'] {
    return (process.env.JWT_ACCESS_EXPIRES_IN ||
      '15m') as JwtSignOptions['expiresIn'];
  }

  // ✅ Important fix:
  // expiresIn must be typed as JwtSignOptions['expiresIn'], not normal string.
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
      secret: process.env.JWT_ACCESS_SECRET || 'dev_access_secret_change_me',
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
      secret: process.env.JWT_REFRESH_SECRET || 'dev_refresh_secret_change_me',
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
    const user = await this.usersService.findOneByEmail(email);

    if (!user) {
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
  // ==========================================================

  async register(userDto: {
    email: string;
    password: string;
    name?: string;
    phone?: string;
  }) {
    const user = await this.usersService.create({
      email: userDto.email,
      password: userDto.password,
      name: userDto.name,
      phone: userDto.phone,
      role: Role.CLIENT,
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

  async login(userOrEmail: any, password?: string) {
    let user: User | null = null;

    // Case 1: login(email, password)
    if (typeof userOrEmail === 'string') {
      user = await this.usersService.findOneByEmail(userOrEmail);

      if (!user) {
        throw new UnauthorizedException('Email ou mot de passe incorrect.');
      }

      if (!user.isActive || user.deletedAt) {
        throw new UnauthorizedException('Compte désactivé.');
      }

      const isPasswordValid = await argon2.verify(
        user.password,
        password || '',
      );

      if (!isPasswordValid) {
        throw new UnauthorizedException('Email ou mot de passe incorrect.');
      }
    }

    // Case 2: login(user)
    else {
      const fullUser = await this.usersService.findOne(userOrEmail.id);

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
          secret:
            process.env.JWT_REFRESH_SECRET || 'dev_refresh_secret_change_me',
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
          secret:
            process.env.JWT_REFRESH_SECRET || 'dev_refresh_secret_change_me',
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
        type: AuthTokenType.REFRESH,
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
    const user = await this.usersService.findOneByEmail(email);

    if (!user || !user.isActive || user.deletedAt) {
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
    });

    if (!tokenRecord) {
      throw new BadRequestException('Token invalide ou expiré.');
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
          type: AuthTokenType.REFRESH,
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

    if (!user.isActive || user.deletedAt) {
      throw new UnauthorizedException('Compte désactivé.');
    }

    const isPasswordValid = await argon2.verify(
      user.password,
      currentPassword,
    );

    if (!isPasswordValid) {
      throw new BadRequestException('Mot de passe actuel incorrect.');
    }

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
          type: AuthTokenType.REFRESH,
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

    if (user.emailVerifiedAt) {
      return {
        message: 'Email déjà vérifié.',
      };
    }

    const rawToken = await this.createOneTimeToken(
      user.id,
      AuthTokenType.EMAIL_VERIFICATION,
      24 * 60 * 60 * 1000,
    );

    const verifyUrl = `${this.getFrontendUrl()}/verify-email?token=${rawToken}`;

    await this.notificationsService.sendEmail(
      user.email,
      'Vérification de votre email',
      `Cliquez sur ce lien pour vérifier votre email: ${verifyUrl}`,
    );

    return {
      message: 'Email de vérification envoyé.',
    };
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
    });

    if (!tokenRecord) {
      throw new BadRequestException('Token invalide ou expiré.');
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

    const code = this.generatePhoneCode();

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
        tokenHash: this.hashToken(code),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    await this.notificationsService.sendSms(
      user.phone,
      `Votre code de vérification est: ${code}`,
    );

    return {
      message: 'Code de vérification envoyé par SMS.',
    };
  }

  // ==========================================================
  // 15. VERIFY PHONE
  // ==========================================================

  async verifyPhone(userId: number, code: string) {
    const tokenRecord = await this.prisma.authToken.findFirst({
      where: {
        userId,
        tokenHash: this.hashToken(code),
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

    const rawToken = await this.createOneTimeToken(
      user.id,
      AuthTokenType.PASSWORD_RESET,
      24 * 60 * 60 * 1000,
    );

    const setupUrl = `${this.getFrontendUrl()}/reset-password?token=${rawToken}`;

    await this.notificationsService.sendEmail(
      user.email,
      'Création de votre mot de passe',
      `Votre compte a été créé. Cliquez ici pour créer votre mot de passe: ${setupUrl}`,
    );

    return {
      message: 'Email de création de mot de passe envoyé.',
    };
  }
}