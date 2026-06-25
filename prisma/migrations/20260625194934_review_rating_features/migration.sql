-- CreateEnum
CREATE TYPE "ReviewModerationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'HIDDEN');

-- AlterTable
ALTER TABLE "ArtisanProfile" ADD COLUMN     "ratingCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Review" ADD COLUMN     "isPriceRespected" BOOLEAN,
ADD COLUMN     "isVisible" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isWorkClean" BOOLEAN,
ADD COLUMN     "moderatedAt" TIMESTAMP(3),
ADD COLUMN     "moderatedById" INTEGER,
ADD COLUMN     "moderationReason" TEXT,
ADD COLUMN     "status" "ReviewModerationStatus" NOT NULL DEFAULT 'PENDING';

-- CreateIndex
CREATE INDEX "ArtisanProfile_ratingCount_idx" ON "ArtisanProfile"("ratingCount");

-- CreateIndex
CREATE INDEX "Review_status_idx" ON "Review"("status");

-- CreateIndex
CREATE INDEX "Review_isVisible_idx" ON "Review"("isVisible");

-- CreateIndex
CREATE INDEX "Review_moderatedById_idx" ON "Review"("moderatedById");
