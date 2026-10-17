import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';

import { UsersModule } from '../users/users.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../../prisma/prisma.module';

import { JwtStrategy } from './strategies/jwt.strategy';
import { getJwtAccessSecret } from '../../config/env';

// ✅ Fix for TS2322: expiresIn typing problem
type JwtExpiresIn =
  | number
  | `${number}ms`
  | `${number}s`
  | `${number}m`
  | `${number}h`
  | `${number}d`
  | `${number}w`
  | `${number}y`;

@Module({
  imports: [
    ConfigModule,

    PrismaModule,

    UsersModule,

    NotificationsModule,

    PassportModule.register({
      defaultStrategy: 'jwt',
      session: false,
    }),

    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (
        configService: ConfigService,
      ): Promise<JwtModuleOptions> => {
        // No fallback: env validation guarantees the secret exists.
        const secret = getJwtAccessSecret();

        const expiresIn =
          (configService.get<string>('JWT_ACCESS_EXPIRES_IN') ||
            '15m') as JwtExpiresIn;

        return {
          secret,
          signOptions: {
            expiresIn,
          },
        };
      },
    }),
  ],

  controllers: [AuthController],

  providers: [
    AuthService,
    JwtStrategy,
  ],

  exports: [
    AuthService,
    JwtModule,
    PassportModule,
  ],
})
export class AuthModule {}
