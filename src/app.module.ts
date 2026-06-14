import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ServeStaticModule } from '@nestjs/serve-static'; // ✅ IMPORTED STATIC MODULE
import { join } from 'path'; // ✅ IMPORTED PATH UTILITY

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

    // 📸 B. Serve Static Files (For Proof of Work Photos)
    // This allows your frontend apps to load images via http://localhost:3000/uploads/...
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'uploads'), 
      serveRoot: '/uploads', 
    }),

    // C. Database Connection (Global Prisma Client)
    PrismaModule,

    // D. Your Application Features
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