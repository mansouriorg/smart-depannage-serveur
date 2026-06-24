/*
  Warnings:

  - A unique constraint covering the columns `[trackingToken]` on the table `Intervention` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `trackingToken` to the `Intervention` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "AuthTokenType" AS ENUM ('REFRESH', 'PASSWORD_RESET', 'EMAIL_VERIFICATION', 'PHONE_VERIFICATION');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "Role" ADD VALUE 'SUPER_ADMIN';
ALTER TYPE "Role" ADD VALUE 'SUPPORT';
ALTER TYPE "Role" ADD VALUE 'DISPATCHER';
ALTER TYPE "Role" ADD VALUE 'ACCOUNTANT';

-- AlterTable
ALTER TABLE "Intervention" ADD COLUMN     "afterPhotoAt" TIMESTAMP(3),
ADD COLUMN     "afterPhotoLat" DOUBLE PRECISION,
ADD COLUMN     "afterPhotoLng" DOUBLE PRECISION,
ADD COLUMN     "afterPhotoUrl" TEXT,
ADD COLUMN     "beforePhotoAt" TIMESTAMP(3),
ADD COLUMN     "beforePhotoLat" DOUBLE PRECISION,
ADD COLUMN     "beforePhotoLng" DOUBLE PRECISION,
ADD COLUMN     "beforePhotoUrl" TEXT,
ADD COLUMN     "feedbackNotes" TEXT,
ADD COLUMN     "hasIssue" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isOnTime" BOOLEAN,
ADD COLUMN     "rating" INTEGER,
ADD COLUMN     "trackingToken" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "address" TEXT,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "passwordChangedAt" TIMESTAMP(3),
ADD COLUMN     "phoneVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "taxId" TEXT,
ADD COLUMN     "website" TEXT;

-- CreateTable
CREATE TABLE "AuthToken" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "type" "AuthTokenType" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AuthToken_tokenHash_key" ON "AuthToken"("tokenHash");

-- CreateIndex
CREATE INDEX "AuthToken_userId_idx" ON "AuthToken"("userId");

-- CreateIndex
CREATE INDEX "AuthToken_userId_type_idx" ON "AuthToken"("userId", "type");

-- CreateIndex
CREATE INDEX "AuthToken_type_idx" ON "AuthToken"("type");

-- CreateIndex
CREATE INDEX "AuthToken_expiresAt_idx" ON "AuthToken"("expiresAt");

-- CreateIndex
CREATE INDEX "ArtisanApplication_status_idx" ON "ArtisanApplication"("status");

-- CreateIndex
CREATE INDEX "ArtisanApplication_createdAt_idx" ON "ArtisanApplication"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Intervention_trackingToken_key" ON "Intervention"("trackingToken");

-- CreateIndex
CREATE INDEX "Intervention_clientId_idx" ON "Intervention"("clientId");

-- CreateIndex
CREATE INDEX "Intervention_artisanId_idx" ON "Intervention"("artisanId");

-- CreateIndex
CREATE INDEX "Intervention_status_idx" ON "Intervention"("status");

-- CreateIndex
CREATE INDEX "Intervention_serviceType_idx" ON "Intervention"("serviceType");

-- CreateIndex
CREATE INDEX "Intervention_createdAt_idx" ON "Intervention"("createdAt");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE INDEX "User_isActive_idx" ON "User"("isActive");

-- CreateIndex
CREATE INDEX "User_deletedAt_idx" ON "User"("deletedAt");

-- CreateIndex
CREATE INDEX "User_phone_idx" ON "User"("phone");

-- AddForeignKey
ALTER TABLE "AuthToken" ADD CONSTRAINT "AuthToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
