import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';

import { validateEnv } from './config/env';

// ==========================================================
// 1. CORE MODULES
// ==========================================================

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { RateLimitModule } from './common/rate-limit/rate-limit.module';
import { StripStaffFieldsInterceptor } from './common/interceptors/strip-staff-fields.interceptor';
import { MoneyNumbersInterceptor } from './common/money/money-numbers.interceptor';
import { AuditInterceptor } from './modules/audit/audit.interceptor';
import { I18nExceptionFilter } from './common/i18n/errors/i18n-exception.filter';

// ==========================================================
// 2. EXISTING FEATURE MODULES
// ==========================================================

import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { FilesModule } from './modules/files/files.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { InterventionsModule } from './modules/interventions/interventions.module';

// ==========================================================
// 3. CLIENT FEATURE MODULES
// ==========================================================

import { ClientAddressesModule } from './modules/client-addresses/client-addresses.module';
import { ServiceCatalogModule } from './modules/service-catalog/service-catalog.module';
import { ServiceZonesModule } from './modules/service-zones/service-zones.module';
import { InterventionEventsModule } from './modules/intervention-events/intervention-events.module';
import { ClientInterventionsModule } from './modules/client-interventions/client-interventions.module';
import { QuotesModule } from './modules/quotes/quotes.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { LocationsModule } from './modules/locations/locations.module';
import { MissionOffersModule } from './modules/mission-offers/mission-offers.module';
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
import { BusinessModule } from './modules/business/business.module';
import { ProofsModule } from './modules/proofs/proofs.module';
import { CashLedgerModule } from './modules/cash-ledger/cash-ledger.module';
import { FinanceModule } from './modules/finance/finance.module';
import { AuditModule } from './modules/audit/audit.module';

// Uploaded files are user content: the browser must use the declared type and
// never guess one (a file that "looks like" HTML would then run).
const noSniff = (res: { setHeader(name: string, value: string): unknown }) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
};

@Module({
  imports: [
    // ======================================================
    // A. GLOBAL CONFIGURATION
    // Loads .env file globally
    // ======================================================

    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      // P0-01: refuse to boot when a required variable is missing.
      validate: validateEnv,
    }),

    // ======================================================
    // B. STATIC FILE SERVING
    //
    // P0-11: only the folders listed here are public. `uploads/private`
    // (identity documents, invoices, quotes, receipts, damage photos...) is
    // NOT served: those files are downloaded through the authenticated route
    // GET /api/files/:fileId/download, which checks who is asking.
    //
    //   /uploads/public  files explicitly marked PUBLIC (e.g. profile photos)
    //
    // P1-07: the proof-of-work photos are not served any more (`uploads/proofs` was
    // public). They are private files read through the same authenticated route;
    // `npm run proofs:migrate` moves the old ones.
    // ======================================================

    ServeStaticModule.forRoot(
      {
        rootPath: join(process.cwd(), 'uploads', 'public'),
        serveRoot: '/uploads/public',
        serveStaticOptions: {
          index: false,
          dotfiles: 'deny',
          setHeaders: noSniff,
        },
      },
    ),

    // ======================================================
    // C. DATABASE
    // ======================================================

    PrismaModule,

    // Shared in-memory counters for login / OTP / reset limits (P0-07)
    RateLimitModule,

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

    // ======================================================
    // F. CLIENT FEATURES
    // ======================================================

    ClientAddressesModule,
    ServiceCatalogModule,
    ServiceZonesModule,
    InterventionEventsModule,
    ClientInterventionsModule,
    QuotesModule,
    PaymentsModule,
    LocationsModule,
    MissionOffersModule,
    InvoicesModule,
    ComplaintsModule,
    BusinessModule,
    MessagesModule,
    ReviewsModule,
    InterventionWorkflowModule,
    SchedulingModule,
    MatchingModule,
    ProofsModule,
    CashLedgerModule,
    FinanceModule,
    AuditModule,

    // ======================================================
    // G. GUEST CLIENT FEATURES
    // ======================================================

    GuestModule,
    AdminModule,
    ArtisansModule,
  ],

  controllers: [AppController],

  providers: [
    AppService,
    // Every write by a person of the back office leaves a row in the audit log (P3-02). First, so it is the outermost:
    // it closes the row after the others have shaped the answer, and writes nothing when a guard has refused.
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    // Responses to non-staff callers never carry staff-only columns
    // (internal notes, tracking token hash).
    { provide: APP_INTERCEPTOR, useClass: StripStaffFieldsInterceptor },
    // Amounts are DECIMAL columns: Prisma answers Decimal objects, the apps read numbers (P2-01).
    { provide: APP_INTERCEPTOR, useClass: MoneyNumbersInterceptor },
    // The sentence of a refusal in the language the app asks for (X-App-Locale); without the header the body is Nest's own (P3-04).
    { provide: APP_FILTER, useClass: I18nExceptionFilter },
  ],
})
export class AppModule {}
