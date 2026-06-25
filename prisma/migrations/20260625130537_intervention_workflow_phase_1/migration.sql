-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "InterventionEventType" ADD VALUE 'BEFORE_PHOTO_UPLOADED';
ALTER TYPE "InterventionEventType" ADD VALUE 'AFTER_PHOTO_UPLOADED';
ALTER TYPE "InterventionEventType" ADD VALUE 'CLIENT_VALIDATION_PENDING';
ALTER TYPE "InterventionEventType" ADD VALUE 'CLIENT_VALIDATED';
ALTER TYPE "InterventionEventType" ADD VALUE 'CLIENT_PAID';
ALTER TYPE "InterventionEventType" ADD VALUE 'INVOICE_SENT';
ALTER TYPE "InterventionEventType" ADD VALUE 'STATUS_CHANGED';
ALTER TYPE "InterventionEventType" ADD VALUE 'INTERNAL_NOTE_ADDED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "Status" ADD VALUE 'CREATED';
ALTER TYPE "Status" ADD VALUE 'WAITING_ADMIN_REVIEW';
ALTER TYPE "Status" ADD VALUE 'ARTISAN_ACCEPTED';
ALTER TYPE "Status" ADD VALUE 'ARTISAN_ON_THE_WAY';
ALTER TYPE "Status" ADD VALUE 'ARTISAN_ARRIVED';
ALTER TYPE "Status" ADD VALUE 'WAITING_CLIENT_VALIDATION';
ALTER TYPE "Status" ADD VALUE 'INVOICE_SENT';

-- AlterTable
ALTER TABLE "Intervention" ADD COLUMN     "adminReviewStartedAt" TIMESTAMP(3),
ADD COLUMN     "assignedAt" TIMESTAMP(3),
ADD COLUMN     "clientValidatedAt" TIMESTAMP(3),
ADD COLUMN     "invoiceSentAt" TIMESTAMP(3),
ADD COLUMN     "paidAt" TIMESTAMP(3),
ADD COLUMN     "paymentPendingAt" TIMESTAMP(3),
ADD COLUMN     "quoteAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "quoteSentAt" TIMESTAMP(3),
ADD COLUMN     "requestCreatedAt" TIMESTAMP(3),
ADD COLUMN     "waitingClientValidationAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Intervention_requestCreatedAt_idx" ON "Intervention"("requestCreatedAt");

-- CreateIndex
CREATE INDEX "Intervention_adminReviewStartedAt_idx" ON "Intervention"("adminReviewStartedAt");

-- CreateIndex
CREATE INDEX "Intervention_quoteSentAt_idx" ON "Intervention"("quoteSentAt");

-- CreateIndex
CREATE INDEX "Intervention_quoteAcceptedAt_idx" ON "Intervention"("quoteAcceptedAt");

-- CreateIndex
CREATE INDEX "Intervention_assignedAt_idx" ON "Intervention"("assignedAt");

-- CreateIndex
CREATE INDEX "Intervention_workStartedAt_idx" ON "Intervention"("workStartedAt");

-- CreateIndex
CREATE INDEX "Intervention_workCompletedAt_idx" ON "Intervention"("workCompletedAt");

-- CreateIndex
CREATE INDEX "Intervention_paymentPendingAt_idx" ON "Intervention"("paymentPendingAt");

-- CreateIndex
CREATE INDEX "Intervention_paidAt_idx" ON "Intervention"("paidAt");

-- CreateIndex
CREATE INDEX "Intervention_invoiceSentAt_idx" ON "Intervention"("invoiceSentAt");

-- CreateIndex
CREATE INDEX "InterventionEvent_createdById_idx" ON "InterventionEvent"("createdById");
