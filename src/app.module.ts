import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

// 1. Core Modules
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module'; // ⚠️ Make sure this file exists in src/prisma/

// 2. Feature Modules
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { FilesModule } from './modules/files/files.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { InterventionsModule } from './modules/interventions/interventions.module';
import { ArtisanApplicationsModule } from './modules/artisan-applications/artisan-applications.module';

@Module({
  imports: [
    // A. Configuration (Loads .env file globally)
    ConfigModule.forRoot({
      isGlobal: true, // Makes ConfigService available everywhere
      envFilePath: '.env', // Path to your environment file
    }),

    // B. Database Connection (Global Prisma Client)
    PrismaModule,

    // C. Your Application Features
    AuthModule,
    UsersModule,
    FilesModule,
    NotificationsModule,
    InterventionsModule,
    ArtisanApplicationsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}