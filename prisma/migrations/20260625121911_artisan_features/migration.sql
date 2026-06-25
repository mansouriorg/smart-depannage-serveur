-- CreateEnum
CREATE TYPE "ArtisanVerificationStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "ArtisanDocumentType" AS ENUM ('IDENTITY', 'COMPANY_LEGAL', 'INSURANCE', 'CERTIFICATE', 'PROFILE_PHOTO', 'OTHER');

-- CreateEnum
CREATE TYPE "ArtisanDocumentStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ArtisanAvailabilityStatus" AS ENUM ('ONLINE', 'OFFLINE', 'BUSY', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "DayOfWeek" AS ENUM ('MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY');

-- CreateEnum
CREATE TYPE "MissionRejectionReason" AS ENUM ('NOT_AVAILABLE', 'TOO_FAR', 'OUT_OF_SPECIALTY', 'PRICE_TOO_LOW', 'OTHER');

-- CreateEnum
CREATE TYPE "MissionProblemType" AS ENUM ('CLIENT_ABSENT', 'ACCESS_ISSUE', 'EXTRA_WORK_REQUIRED', 'SAFETY_RISK', 'MATERIAL_MISSING', 'CLIENT_DISPUTE', 'OTHER');

-- AlterTable
ALTER TABLE "Intervention" ADD COLUMN     "artisanAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "artisanArrivedAt" TIMESTAMP(3),
ADD COLUMN     "artisanOnTheWayAt" TIMESTAMP(3),
ADD COLUMN     "artisanRejectedAt" TIMESTAMP(3),
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "clientSignatureAt" TIMESTAMP(3),
ADD COLUMN     "clientSignatureUrl" TEXT,
ADD COLUMN     "diagnosticNotes" TEXT,
ADD COLUMN     "extraQuoteReason" TEXT,
ADD COLUMN     "extraQuoteRequested" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastStatusChangedAt" TIMESTAMP(3),
ADD COLUMN     "materialUsed" JSONB,
ADD COLUMN     "problemNotes" TEXT,
ADD COLUMN     "problemReported" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "problemType" "MissionProblemType",
ADD COLUMN     "workCompletedAt" TIMESTAMP(3),
ADD COLUMN     "workStartedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ArtisanProfile" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "specialty" TEXT,
    "specialties" TEXT[],
    "yearsExperience" INTEGER NOT NULL DEFAULT 0,
    "companyName" TEXT,
    "companyNumber" TEXT,
    "insuranceNumber" TEXT,
    "bio" TEXT,
    "profilePhotoUrl" TEXT,
    "verificationStatus" "ArtisanVerificationStatus" NOT NULL DEFAULT 'DRAFT',
    "rejectionReason" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "verifiedById" INTEGER,
    "availabilityStatus" "ArtisanAvailabilityStatus" NOT NULL DEFAULT 'OFFLINE',
    "isAcceptingJobs" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenAt" TIMESTAMP(3),
    "averageRating" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "completedJobsCount" INTEGER NOT NULL DEFAULT 0,
    "cancelledJobsCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArtisanProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArtisanDocument" (
    "id" SERIAL NOT NULL,
    "artisanProfileId" INTEGER NOT NULL,
    "type" "ArtisanDocumentType" NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "fileName" TEXT,
    "mimeType" TEXT,
    "status" "ArtisanDocumentStatus" NOT NULL DEFAULT 'PENDING',
    "rejectionNote" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" INTEGER,

    CONSTRAINT "ArtisanDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArtisanServiceZone" (
    "id" SERIAL NOT NULL,
    "artisanProfileId" INTEGER NOT NULL,
    "label" TEXT,
    "city" TEXT,
    "postalCode" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "radiusKm" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArtisanServiceZone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArtisanAvailabilitySlot" (
    "id" SERIAL NOT NULL,
    "artisanProfileId" INTEGER NOT NULL,
    "dayOfWeek" "DayOfWeek" NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArtisanAvailabilitySlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArtisanBankDetails" (
    "id" SERIAL NOT NULL,
    "artisanProfileId" INTEGER NOT NULL,
    "accountHolderName" TEXT,
    "bankName" TEXT,
    "iban" TEXT,
    "bic" TEXT,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArtisanBankDetails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArtisanMissionRejection" (
    "id" SERIAL NOT NULL,
    "artisanProfileId" INTEGER NOT NULL,
    "interventionId" INTEGER NOT NULL,
    "reason" "MissionRejectionReason" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArtisanMissionRejection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ArtisanProfile_userId_key" ON "ArtisanProfile"("userId");

-- CreateIndex
CREATE INDEX "ArtisanProfile_verificationStatus_idx" ON "ArtisanProfile"("verificationStatus");

-- CreateIndex
CREATE INDEX "ArtisanProfile_availabilityStatus_idx" ON "ArtisanProfile"("availabilityStatus");

-- CreateIndex
CREATE INDEX "ArtisanProfile_isAcceptingJobs_idx" ON "ArtisanProfile"("isAcceptingJobs");

-- CreateIndex
CREATE INDEX "ArtisanProfile_lastSeenAt_idx" ON "ArtisanProfile"("lastSeenAt");

-- CreateIndex
CREATE INDEX "ArtisanDocument_artisanProfileId_idx" ON "ArtisanDocument"("artisanProfileId");

-- CreateIndex
CREATE INDEX "ArtisanDocument_type_idx" ON "ArtisanDocument"("type");

-- CreateIndex
CREATE INDEX "ArtisanDocument_status_idx" ON "ArtisanDocument"("status");

-- CreateIndex
CREATE INDEX "ArtisanServiceZone_artisanProfileId_idx" ON "ArtisanServiceZone"("artisanProfileId");

-- CreateIndex
CREATE INDEX "ArtisanServiceZone_isActive_idx" ON "ArtisanServiceZone"("isActive");

-- CreateIndex
CREATE INDEX "ArtisanServiceZone_postalCode_idx" ON "ArtisanServiceZone"("postalCode");

-- CreateIndex
CREATE INDEX "ArtisanServiceZone_city_idx" ON "ArtisanServiceZone"("city");

-- CreateIndex
CREATE INDEX "ArtisanAvailabilitySlot_artisanProfileId_idx" ON "ArtisanAvailabilitySlot"("artisanProfileId");

-- CreateIndex
CREATE INDEX "ArtisanAvailabilitySlot_dayOfWeek_idx" ON "ArtisanAvailabilitySlot"("dayOfWeek");

-- CreateIndex
CREATE UNIQUE INDEX "ArtisanBankDetails_artisanProfileId_key" ON "ArtisanBankDetails"("artisanProfileId");

-- CreateIndex
CREATE INDEX "ArtisanMissionRejection_artisanProfileId_idx" ON "ArtisanMissionRejection"("artisanProfileId");

-- CreateIndex
CREATE INDEX "ArtisanMissionRejection_interventionId_idx" ON "ArtisanMissionRejection"("interventionId");

-- CreateIndex
CREATE INDEX "ArtisanMissionRejection_reason_idx" ON "ArtisanMissionRejection"("reason");

-- CreateIndex
CREATE INDEX "Intervention_lastStatusChangedAt_idx" ON "Intervention"("lastStatusChangedAt");

-- AddForeignKey
ALTER TABLE "ArtisanProfile" ADD CONSTRAINT "ArtisanProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtisanDocument" ADD CONSTRAINT "ArtisanDocument_artisanProfileId_fkey" FOREIGN KEY ("artisanProfileId") REFERENCES "ArtisanProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtisanServiceZone" ADD CONSTRAINT "ArtisanServiceZone_artisanProfileId_fkey" FOREIGN KEY ("artisanProfileId") REFERENCES "ArtisanProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtisanAvailabilitySlot" ADD CONSTRAINT "ArtisanAvailabilitySlot_artisanProfileId_fkey" FOREIGN KEY ("artisanProfileId") REFERENCES "ArtisanProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtisanBankDetails" ADD CONSTRAINT "ArtisanBankDetails_artisanProfileId_fkey" FOREIGN KEY ("artisanProfileId") REFERENCES "ArtisanProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtisanMissionRejection" ADD CONSTRAINT "ArtisanMissionRejection_artisanProfileId_fkey" FOREIGN KEY ("artisanProfileId") REFERENCES "ArtisanProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtisanMissionRejection" ADD CONSTRAINT "ArtisanMissionRejection_interventionId_fkey" FOREIGN KEY ("interventionId") REFERENCES "Intervention"("id") ON DELETE CASCADE ON UPDATE CASCADE;
