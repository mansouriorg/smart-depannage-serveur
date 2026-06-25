-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('REQUESTED', 'SCHEDULED', 'CONFIRMED', 'RESCHEDULE_REQUESTED', 'CANCEL_REQUESTED', 'CANCELLED', 'COMPLETED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "AppointmentRequestType" AS ENUM ('RESCHEDULE', 'CANCEL');

-- CreateEnum
CREATE TYPE "AppointmentRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AppointmentReminderStatus" AS ENUM ('PENDING', 'SENT', 'SKIPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "ArtisanTimeBlockType" AS ENUM ('UNAVAILABLE', 'BREAK', 'VACATION', 'PERSONAL', 'OTHER');

-- CreateTable
CREATE TABLE "Appointment" (
    "id" SERIAL NOT NULL,
    "interventionId" INTEGER NOT NULL,
    "clientId" INTEGER NOT NULL,
    "artisanId" INTEGER,
    "status" "AppointmentStatus" NOT NULL DEFAULT 'REQUESTED',
    "preferredDate" TIMESTAMP(3),
    "preferredStartTime" TEXT,
    "preferredEndTime" TEXT,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Paris',
    "clientNote" TEXT,
    "adminNote" TEXT,
    "artisanNote" TEXT,
    "scheduledById" INTEGER,
    "confirmedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppointmentRequest" (
    "id" SERIAL NOT NULL,
    "appointmentId" INTEGER NOT NULL,
    "requestedById" INTEGER,
    "type" "AppointmentRequestType" NOT NULL,
    "status" "AppointmentRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requestedStartAt" TIMESTAMP(3),
    "requestedEndAt" TIMESTAMP(3),
    "reason" TEXT,
    "adminResponse" TEXT,
    "reviewedById" INTEGER,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppointmentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppointmentReminder" (
    "id" SERIAL NOT NULL,
    "appointmentId" INTEGER NOT NULL,
    "recipientId" INTEGER,
    "minutesBefore" INTEGER NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "status" "AppointmentReminderStatus" NOT NULL DEFAULT 'PENDING',
    "sentAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppointmentReminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArtisanTimeBlock" (
    "id" SERIAL NOT NULL,
    "artisanId" INTEGER NOT NULL,
    "type" "ArtisanTimeBlockType" NOT NULL DEFAULT 'UNAVAILABLE',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArtisanTimeBlock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Appointment_interventionId_key" ON "Appointment"("interventionId");

-- CreateIndex
CREATE INDEX "Appointment_interventionId_idx" ON "Appointment"("interventionId");

-- CreateIndex
CREATE INDEX "Appointment_clientId_idx" ON "Appointment"("clientId");

-- CreateIndex
CREATE INDEX "Appointment_artisanId_idx" ON "Appointment"("artisanId");

-- CreateIndex
CREATE INDEX "Appointment_status_idx" ON "Appointment"("status");

-- CreateIndex
CREATE INDEX "Appointment_preferredDate_idx" ON "Appointment"("preferredDate");

-- CreateIndex
CREATE INDEX "Appointment_startsAt_idx" ON "Appointment"("startsAt");

-- CreateIndex
CREATE INDEX "Appointment_endsAt_idx" ON "Appointment"("endsAt");

-- CreateIndex
CREATE INDEX "Appointment_scheduledById_idx" ON "Appointment"("scheduledById");

-- CreateIndex
CREATE INDEX "Appointment_createdAt_idx" ON "Appointment"("createdAt");

-- CreateIndex
CREATE INDEX "Appointment_artisanId_startsAt_endsAt_idx" ON "Appointment"("artisanId", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "AppointmentRequest_appointmentId_idx" ON "AppointmentRequest"("appointmentId");

-- CreateIndex
CREATE INDEX "AppointmentRequest_requestedById_idx" ON "AppointmentRequest"("requestedById");

-- CreateIndex
CREATE INDEX "AppointmentRequest_type_idx" ON "AppointmentRequest"("type");

-- CreateIndex
CREATE INDEX "AppointmentRequest_status_idx" ON "AppointmentRequest"("status");

-- CreateIndex
CREATE INDEX "AppointmentRequest_requestedStartAt_idx" ON "AppointmentRequest"("requestedStartAt");

-- CreateIndex
CREATE INDEX "AppointmentRequest_requestedEndAt_idx" ON "AppointmentRequest"("requestedEndAt");

-- CreateIndex
CREATE INDEX "AppointmentRequest_reviewedById_idx" ON "AppointmentRequest"("reviewedById");

-- CreateIndex
CREATE INDEX "AppointmentRequest_createdAt_idx" ON "AppointmentRequest"("createdAt");

-- CreateIndex
CREATE INDEX "AppointmentReminder_appointmentId_idx" ON "AppointmentReminder"("appointmentId");

-- CreateIndex
CREATE INDEX "AppointmentReminder_recipientId_idx" ON "AppointmentReminder"("recipientId");

-- CreateIndex
CREATE INDEX "AppointmentReminder_status_idx" ON "AppointmentReminder"("status");

-- CreateIndex
CREATE INDEX "AppointmentReminder_dueAt_idx" ON "AppointmentReminder"("dueAt");

-- CreateIndex
CREATE INDEX "AppointmentReminder_sentAt_idx" ON "AppointmentReminder"("sentAt");

-- CreateIndex
CREATE INDEX "AppointmentReminder_createdAt_idx" ON "AppointmentReminder"("createdAt");

-- CreateIndex
CREATE INDEX "ArtisanTimeBlock_artisanId_idx" ON "ArtisanTimeBlock"("artisanId");

-- CreateIndex
CREATE INDEX "ArtisanTimeBlock_type_idx" ON "ArtisanTimeBlock"("type");

-- CreateIndex
CREATE INDEX "ArtisanTimeBlock_startsAt_idx" ON "ArtisanTimeBlock"("startsAt");

-- CreateIndex
CREATE INDEX "ArtisanTimeBlock_endsAt_idx" ON "ArtisanTimeBlock"("endsAt");

-- CreateIndex
CREATE INDEX "ArtisanTimeBlock_createdById_idx" ON "ArtisanTimeBlock"("createdById");

-- CreateIndex
CREATE INDEX "ArtisanTimeBlock_createdAt_idx" ON "ArtisanTimeBlock"("createdAt");

-- CreateIndex
CREATE INDEX "ArtisanTimeBlock_artisanId_startsAt_endsAt_idx" ON "ArtisanTimeBlock"("artisanId", "startsAt", "endsAt");

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_interventionId_fkey" FOREIGN KEY ("interventionId") REFERENCES "Intervention"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_artisanId_fkey" FOREIGN KEY ("artisanId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentRequest" ADD CONSTRAINT "AppointmentRequest_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentReminder" ADD CONSTRAINT "AppointmentReminder_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtisanTimeBlock" ADD CONSTRAINT "ArtisanTimeBlock_artisanId_fkey" FOREIGN KEY ("artisanId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
