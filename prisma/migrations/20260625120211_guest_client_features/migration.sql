-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuthTokenType" ADD VALUE 'GUEST_MAGIC_LINK';
ALTER TYPE "AuthTokenType" ADD VALUE 'GUEST_OTP';

-- AlterTable
ALTER TABLE "Intervention" ADD COLUMN     "contactEmail" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "guestActivatedAt" TIMESTAMP(3),
ADD COLUMN     "isGuest" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Intervention_contactPhone_idx" ON "Intervention"("contactPhone");

-- CreateIndex
CREATE INDEX "Intervention_contactEmail_idx" ON "Intervention"("contactEmail");

-- CreateIndex
CREATE INDEX "User_isGuest_idx" ON "User"("isGuest");
