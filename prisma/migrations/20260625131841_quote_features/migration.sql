-- AlterTable
ALTER TABLE "Quote" ADD COLUMN     "acceptedAt" TIMESTAMP(3),
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "expiredAt" TIMESTAMP(3),
ADD COLUMN     "rejectedAt" TIMESTAMP(3),
ADD COLUMN     "sentAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Quote_createdById_idx" ON "Quote"("createdById");

-- CreateIndex
CREATE INDEX "Quote_expiresAt_idx" ON "Quote"("expiresAt");

-- CreateIndex
CREATE INDEX "Quote_sentAt_idx" ON "Quote"("sentAt");

-- CreateIndex
CREATE INDEX "Quote_acceptedAt_idx" ON "Quote"("acceptedAt");

-- CreateIndex
CREATE INDEX "Quote_rejectedAt_idx" ON "Quote"("rejectedAt");

-- CreateIndex
CREATE INDEX "Quote_expiredAt_idx" ON "Quote"("expiredAt");

-- CreateIndex
CREATE INDEX "Quote_cancelledAt_idx" ON "Quote"("cancelledAt");

-- CreateIndex
CREATE INDEX "Quote_createdAt_idx" ON "Quote"("createdAt");

-- CreateIndex
CREATE INDEX "QuoteItem_quoteId_idx" ON "QuoteItem"("quoteId");

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
