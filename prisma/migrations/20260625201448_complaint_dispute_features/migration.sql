-- CreateEnum
CREATE TYPE "ComplaintDecision" AS ENUM ('CLIENT_FAVOR', 'ARTISAN_FAVOR', 'PARTIAL_REFUND', 'FULL_REFUND', 'NO_REFUND', 'OTHER');

-- CreateEnum
CREATE TYPE "ComplaintRefundDecision" AS ENUM ('NOT_REQUESTED', 'PENDING', 'APPROVED', 'REJECTED', 'PARTIAL_REFUND', 'REFUNDED');

-- AlterTable
ALTER TABLE "Complaint" ADD COLUMN     "adminDecision" "ComplaintDecision",
ADD COLUMN     "adminDecisionAt" TIMESTAMP(3),
ADD COLUMN     "adminDecisionById" INTEGER,
ADD COLUMN     "adminDecisionNote" TEXT,
ADD COLUMN     "artisanRespondedAt" TIMESTAMP(3),
ADD COLUMN     "artisanResponse" TEXT,
ADD COLUMN     "clientMessage" TEXT,
ADD COLUMN     "photos" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "refundDecidedById" INTEGER,
ADD COLUMN     "refundDecision" "ComplaintRefundDecision" NOT NULL DEFAULT 'NOT_REQUESTED',
ADD COLUMN     "rejectedAt" TIMESTAMP(3),
ADD COLUMN     "resolutionNotes" TEXT,
ADD COLUMN     "resolvedAt" TIMESTAMP(3),
ALTER COLUMN "attachments" SET DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "ComplaintMessage" (
    "id" SERIAL NOT NULL,
    "complaintId" INTEGER NOT NULL,
    "senderId" INTEGER,
    "senderRole" "Role" NOT NULL,
    "content" TEXT NOT NULL,
    "attachments" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isInternal" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComplaintMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ComplaintMessage_complaintId_idx" ON "ComplaintMessage"("complaintId");

-- CreateIndex
CREATE INDEX "ComplaintMessage_senderId_idx" ON "ComplaintMessage"("senderId");

-- CreateIndex
CREATE INDEX "ComplaintMessage_senderRole_idx" ON "ComplaintMessage"("senderRole");

-- CreateIndex
CREATE INDEX "ComplaintMessage_isInternal_idx" ON "ComplaintMessage"("isInternal");

-- CreateIndex
CREATE INDEX "ComplaintMessage_deletedAt_idx" ON "ComplaintMessage"("deletedAt");

-- CreateIndex
CREATE INDEX "ComplaintMessage_createdAt_idx" ON "ComplaintMessage"("createdAt");

-- CreateIndex
CREATE INDEX "Complaint_refundRequested_idx" ON "Complaint"("refundRequested");

-- CreateIndex
CREATE INDEX "Complaint_refundDecision_idx" ON "Complaint"("refundDecision");

-- CreateIndex
CREATE INDEX "Complaint_refundApproved_idx" ON "Complaint"("refundApproved");

-- CreateIndex
CREATE INDEX "Complaint_adminDecision_idx" ON "Complaint"("adminDecision");

-- CreateIndex
CREATE INDEX "Complaint_closedAt_idx" ON "Complaint"("closedAt");

-- AddForeignKey
ALTER TABLE "Complaint" ADD CONSTRAINT "Complaint_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplaintMessage" ADD CONSTRAINT "ComplaintMessage_complaintId_fkey" FOREIGN KEY ("complaintId") REFERENCES "Complaint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplaintMessage" ADD CONSTRAINT "ComplaintMessage_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
