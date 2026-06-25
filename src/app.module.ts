import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';

// ==========================================================
// 1. CORE MODULES
// ==========================================================

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';

// ==========================================================
// 2. EXISTING FEATURE MODULES
// ==========================================================

import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { FilesModule } from './modules/files/files.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { InterventionsModule } from './modules/interventions/interventions.module';
import { ArtisanApplicationsModule } from './modules/artisan-applications/artisan-applications.module';

// ==========================================================
// 3. CLIENT FEATURE MODULES
// ==========================================================

import { ClientAddressesModule } from './modules/client-addresses/client-addresses.module';
import { NotificationPreferencesModule } from './modules/notification-preferences/notification-preferences.module';
import { ServiceCatalogModule } from './modules/service-catalog/service-catalog.module';
import { InterventionEventsModule } from './modules/intervention-events/intervention-events.module';
import { ClientInterventionsModule } from './modules/client-interventions/client-interventions.module';
import { QuotesModule } from './modules/quotes/quotes.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { InvoicesModule } from './modules/invoices/invoices.module';
import { ComplaintsModule } from './modules/complaints/complaints.module';
import { MessagesModule } from './modules/messages/messages.module';
import { ReviewsModule } from './modules/reviews/reviews.module';

// ==========================================================
// 4. GUEST CLIENT MODULE
// ==========================================================

import { GuestModule } from './modules/guest/guest.module';
import { ArtisansModule } from './modules/artisans/artisans.module';
import { AdminModule } from './modules/admin/admin.module';
import { InterventionWorkflowModule } from './modules/intervention-workflow/intervention-workflow.module';
import { SchedulingModule } from './modules/scheduling/scheduling.module';
import { MatchingModule } from './modules/matching/matching.module';

@Module({
  imports: [
    // ======================================================
    // A. GLOBAL CONFIGURATION
    // Loads .env file globally
    // ======================================================

    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),

    // ======================================================
    // B. STATIC FILE SERVING
    // Allows frontend to access files using:
    // http://localhost:3000/uploads/...
    // ======================================================

    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'uploads'),
      serveRoot: '/uploads',
    }),

    // ======================================================
    // C. DATABASE
    // ======================================================

    PrismaModule,

    // ======================================================
    // D. AUTH / USERS / CORE FEATURES
    // ======================================================

    AuthModule,
    UsersModule,
    FilesModule,
    NotificationsModule,

    // ======================================================
    // E. EXISTING BUSINESS FEATURES
    // ======================================================

    InterventionsModule,
    ArtisanApplicationsModule,

    // ======================================================
    // F. CLIENT FEATURES
    // ======================================================

    ClientAddressesModule,
    NotificationPreferencesModule,
    ServiceCatalogModule,
    InterventionEventsModule,
    ClientInterventionsModule,
    QuotesModule,
    PaymentsModule,
    InvoicesModule,
    ComplaintsModule,
    MessagesModule,
    ReviewsModule,
    InterventionWorkflowModule,
    SchedulingModule,
    MatchingModule,

    // ======================================================
    // G. GUEST CLIENT FEATURES
    // ======================================================

    GuestModule,
    AdminModule,
    ArtisansModule,
  ],

  controllers: [AppController],

  providers: [AppService],
})
export class AppModule {}