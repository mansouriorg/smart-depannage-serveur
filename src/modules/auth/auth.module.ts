import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { UsersModule } from '../users/users.module';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
// We will create the JwtStrategy in the next step, so I've commented it out for now
// import { JwtStrategy } from './jwt.strategy'; 

@Module({
  imports: [
    // 1. Import UsersModule so AuthService can find users in the database
    UsersModule,
    
    // 2. Setup Passport
    PassportModule,

    // 3. Setup JWT (JSON Web Tokens)
    // We use registerAsync to load the secret from the .env file
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
        signOptions: { 
          expiresIn: '7d', // Token expires in 7 days (good for mobile apps)
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService, 
    // JwtStrategy, // Uncomment this after we create the strategy file next
  ],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}