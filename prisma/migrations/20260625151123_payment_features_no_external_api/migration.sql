/*
  Warnings:

  - A unique constraint covering the columns `[receiptNumber]` on the table `Payment` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('MANUAL', 'INTERNAL', 'STRIPE', 'PAYPAL', 'KONNECT', 'PAYMEE', 'FLOUCI', 'BANK_TRANSFER', 'CASH');

-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'ONLINE_CARD';

-- AlterEnum
ALTER TYPE "PaymentStatus" ADD VALUE 'PARTIALLY_REFUNDED';

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "amountRefunded" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "confirmedById" INTEGER,
ADD COLUMN     "createdById" INTEGER,
ADD COLUMN     "failureReason" TEXT,
ADD COLUMN     "invoiceId" INTEGER,
ADD COLUMN     "provider" "PaymentProvider" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "providerPaymentId" TEXT,
ADD COLUMN     "receiptGeneratedAt" TIMESTAMP(3),
ADD COLUMN     "receiptNumber" TEXT,
ADD COLUMN     "receiptUrl" TEXT,
ADD COLUMN     "refundReason" TEXT,
ADD COLUMN     "refundedById" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "Payment_receiptNumber_key" ON "Payment"("receiptNumber");

-- CreateIndex
CREATE INDEX "Payment_invoiceId_idx" ON "Payment"("invoiceId");

-- CreateIndex
CREATE INDEX "Payment_provider_idx" ON "Payment"("provider");

-- CreateIndex
CREATE INDEX "Payment_reference_idx" ON "Payment"("reference");

-- CreateIndex
CREATE INDEX "Payment_providerPaymentId_idx" ON "Payment"("providerPaymentId");

-- CreateIndex
CREATE INDEX "Payment_receiptNumber_idx" ON "Payment"("receiptNumber");

-- CreateIndex
CREATE INDEX "Payment_createdById_idx" ON "Payment"("createdById");

-- CreateIndex
CREATE INDEX "Payment_confirmedById_idx" ON "Payment"("confirmedById");

-- CreateIndex
CREATE INDEX "Payment_refundedById_idx" ON "Payment"("refundedById");

-- CreateIndex
CREATE INDEX "Payment_requestedAt_idx" ON "Payment"("requestedAt");

-- CreateIndex
CREATE INDEX "Payment_confirmedAt_idx" ON "Payment"("confirmedAt");

-- CreateIndex
CREATE INDEX "Payment_failedAt_idx" ON "Payment"("failedAt");

-- CreateIndex
CREATE INDEX "Payment_refundedAt_idx" ON "Payment"("refundedAt");

-- CreateIndex
CREATE INDEX "Payment_cancelledAt_idx" ON "Payment"("cancelledAt");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
