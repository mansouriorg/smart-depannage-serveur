import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { UsersModule } from '../users/users.module';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';

// ✅ 1. Import the Strategy we just created
import { JwtStrategy } from './jwt.strategy'; 

@Module({
  imports: [
    UsersModule,
    
    // 2. Setup Passport with default strategy
    PassportModule.register({ defaultStrategy: 'jwt' }),

    // 3. Setup JWT (JSON Web Tokens)
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => ({
        // ⚠️ FIX: use getOrThrow so app fails fast if secret is missing
        secret: configService.getOrThrow<string>('JWT_SECRET'),
        signOptions: { 
          expiresIn: '7d', // Token expires in 7 days
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService, 
    // ✅ 4. Add JwtStrategy here!
    // This tells NestJS to initialize the strategy so Passport can use it.
    JwtStrategy, 
  ],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}