-- CreateEnum
CREATE TYPE "AdminNoteTargetType" AS ENUM ('INTERVENTION', 'CLIENT', 'ARTISAN', 'COMPLAINT', 'PAYMENT', 'INVOICE');

-- CreateEnum
CREATE TYPE "NotificationTemplateType" AS ENUM ('SMS', 'EMAIL', 'PUSH');

-- AlterTable
ALTER TABLE "Complaint" ADD COLUMN     "assignedToId" INTEGER,
ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "internalNotes" TEXT,
ADD COLUMN     "refundAmount" DOUBLE PRECISION,
ADD COLUMN     "refundApproved" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "refundDecidedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Intervention" ADD COLUMN     "adminInternalNotes" TEXT,
ADD COLUMN     "cancelledById" INTEGER,
ADD COLUMN     "cancelledReason" TEXT;

-- CreateTable
CREATE TABLE "AdminInternalNote" (
    "id" SERIAL NOT NULL,
    "targetType" "AdminNoteTargetType" NOT NULL,
    "targetId" INTEGER NOT NULL,
    "authorId" INTEGER,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminInternalNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanySettings" (
    "id" SERIAL NOT NULL,
    "companyName" TEXT,
    "companyPhone" TEXT,
    "companyEmail" TEXT,
    "smsSender" TEXT,
    "defaultTaxRate" DOUBLE PRECISION NOT NULL DEFAULT 20,
    "defaultEmergencyFee" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "openingHours" JSONB,
    "paymentMethods" TEXT[],
    "termsAndConditions" TEXT,
    "privacyPolicy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanySettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminServiceZone" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT,
    "postalCode" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "radiusKm" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminServiceZone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationTemplate" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "type" "NotificationTemplateType" NOT NULL,
    "subject" TEXT,
    "content" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminInternalNote_targetType_idx" ON "AdminInternalNote"("targetType");

-- CreateIndex
CREATE INDEX "AdminInternalNote_targetId_idx" ON "AdminInternalNote"("targetId");

-- CreateIndex
CREATE INDEX "AdminInternalNote_authorId_idx" ON "AdminInternalNote"("authorId");

-- CreateIndex
CREATE INDEX "AdminInternalNote_createdAt_idx" ON "AdminInternalNote"("createdAt");

-- CreateIndex
CREATE INDEX "AdminServiceZone_city_idx" ON "AdminServiceZone"("city");

-- CreateIndex
CREATE INDEX "AdminServiceZone_postalCode_idx" ON "AdminServiceZone"("postalCode");

-- CreateIndex
CREATE INDEX "AdminServiceZone_isActive_idx" ON "AdminServiceZone"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationTemplate_key_key" ON "NotificationTemplate"("key");

-- CreateIndex
CREATE INDEX "NotificationTemplate_key_idx" ON "NotificationTemplate"("key");

-- CreateIndex
CREATE INDEX "NotificationTemplate_type_idx" ON "NotificationTemplate"("type");

-- CreateIndex
CREATE INDEX "NotificationTemplate_isActive_idx" ON "NotificationTemplate"("isActive");

-- CreateIndex
CREATE INDEX "ArtisanDocument_uploadedAt_idx" ON "ArtisanDocument"("uploadedAt");

-- CreateIndex
CREATE INDEX "Complaint_assignedToId_idx" ON "Complaint"("assignedToId");

-- CreateIndex
CREATE INDEX "Complaint_createdAt_idx" ON "Complaint"("createdAt");

-- CreateIndex
CREATE INDEX "Intervention_cancelledById_idx" ON "Intervention"("cancelledById");

-- CreateIndex
CREATE INDEX "Message_isRead_idx" ON "Message"("isRead");

-- CreateIndex
CREATE INDEX "Message_createdAt_idx" ON "Message"("createdAt");

-- CreateIndex
CREATE INDEX "Payment_quoteId_idx" ON "Payment"("quoteId");

-- CreateIndex
CREATE INDEX "Payment_createdAt_idx" ON "Payment"("createdAt");

-- CreateIndex
CREATE INDEX "Review_rating_idx" ON "Review"("rating");

-- CreateIndex
CREATE INDEX "Review_createdAt_idx" ON "Review"("createdAt");
