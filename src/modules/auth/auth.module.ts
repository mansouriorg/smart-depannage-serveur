import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';

import { UsersModule } from '../users/users.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../../prisma/prisma.module';

// If your JwtStrategy file is here:
// src/modules/auth/jwt.strategy.ts
import { JwtStrategy } from './jwt.strategy';

// If your JwtStrategy file is here instead:
// src/modules/auth/strategies/jwt.strategy.ts
// replace the import above with:
// import { JwtStrategy } from './strategies/jwt.strategy';

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
        const secret =
          configService.get<string>('JWT_ACCESS_SECRET') ||
          configService.get<string>('JWT_SECRET') ||
          'dev_access_secret_change_me';

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