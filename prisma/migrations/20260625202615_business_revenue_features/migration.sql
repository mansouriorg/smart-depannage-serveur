-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'READY', 'PAID', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BusinessExportFormat" AS ENUM ('CSV', 'PDF', 'JSON');

-- CreateEnum
CREATE TYPE "AccountingExportStatus" AS ENUM ('GENERATED', 'FAILED');

-- CreateTable
CREATE TABLE "InterventionFinancials" (
    "id" SERIAL NOT NULL,
    "interventionId" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "totalPrice" DOUBLE PRECISION NOT NULL,
    "commissionRate" DOUBLE PRECISION NOT NULL DEFAULT 20,
    "platformCommission" DOUBLE PRECISION NOT NULL,
    "artisanPayout" DOUBLE PRECISION NOT NULL,
    "paymentProviderFee" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "refundAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "netRevenue" DOUBLE PRECISION NOT NULL,
    "companyMargin" DOUBLE PRECISION NOT NULL,
    "notes" TEXT,
    "calculatedById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InterventionFinancials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArtisanPayout" (
    "id" SERIAL NOT NULL,
    "artisanId" INTEGER NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "grossAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "paymentProviderFees" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "refundsDeducted" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "netAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "paymentReference" TEXT,
    "paidAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArtisanPayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArtisanPayoutItem" (
    "id" SERIAL NOT NULL,
    "payoutId" INTEGER NOT NULL,
    "financialId" INTEGER NOT NULL,
    "interventionId" INTEGER NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArtisanPayoutItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessReport" (
    "id" SERIAL NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "label" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "interventionCount" INTEGER NOT NULL DEFAULT 0,
    "paidInterventionCount" INTEGER NOT NULL DEFAULT 0,
    "refundedCount" INTEGER NOT NULL DEFAULT 0,
    "totalRevenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalCommission" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalArtisanPayouts" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalPaymentFees" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalRefunds" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "netRevenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "companyMargin" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "data" JSONB,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountingExport" (
    "id" SERIAL NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "format" "BusinessExportFormat" NOT NULL DEFAULT 'CSV',
    "status" "AccountingExportStatus" NOT NULL DEFAULT 'GENERATED',
    "fileName" TEXT,
    "fileUrl" TEXT,
    "totalLines" INTEGER NOT NULL DEFAULT 0,
    "totalDebit" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalCredit" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "data" JSONB,
    "generatedById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountingExport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InterventionFinancials_interventionId_key" ON "InterventionFinancials"("interventionId");

-- CreateIndex
CREATE INDEX "InterventionFinancials_interventionId_idx" ON "InterventionFinancials"("interventionId");

-- CreateIndex
CREATE INDEX "InterventionFinancials_currency_idx" ON "InterventionFinancials"("currency");

-- CreateIndex
CREATE INDEX "InterventionFinancials_commissionRate_idx" ON "InterventionFinancials"("commissionRate");

-- CreateIndex
CREATE INDEX "InterventionFinancials_totalPrice_idx" ON "InterventionFinancials"("totalPrice");

-- CreateIndex
CREATE INDEX "InterventionFinancials_platformCommission_idx" ON "InterventionFinancials"("platformCommission");

-- CreateIndex
CREATE INDEX "InterventionFinancials_artisanPayout_idx" ON "InterventionFinancials"("artisanPayout");

-- CreateIndex
CREATE INDEX "InterventionFinancials_paymentProviderFee_idx" ON "InterventionFinancials"("paymentProviderFee");

-- CreateIndex
CREATE INDEX "InterventionFinancials_refundAmount_idx" ON "InterventionFinancials"("refundAmount");

-- CreateIndex
CREATE INDEX "InterventionFinancials_netRevenue_idx" ON "InterventionFinancials"("netRevenue");

-- CreateIndex
CREATE INDEX "InterventionFinancials_companyMargin_idx" ON "InterventionFinancials"("companyMargin");

-- CreateIndex
CREATE INDEX "InterventionFinancials_calculatedById_idx" ON "InterventionFinancials"("calculatedById");

-- CreateIndex
CREATE INDEX "InterventionFinancials_createdAt_idx" ON "InterventionFinancials"("createdAt");

-- CreateIndex
CREATE INDEX "ArtisanPayout_artisanId_idx" ON "ArtisanPayout"("artisanId");

-- CreateIndex
CREATE INDEX "ArtisanPayout_status_idx" ON "ArtisanPayout"("status");

-- CreateIndex
CREATE INDEX "ArtisanPayout_periodStart_idx" ON "ArtisanPayout"("periodStart");

-- CreateIndex
CREATE INDEX "ArtisanPayout_periodEnd_idx" ON "ArtisanPayout"("periodEnd");

-- CreateIndex
CREATE INDEX "ArtisanPayout_currency_idx" ON "ArtisanPayout"("currency");

-- CreateIndex
CREATE INDEX "ArtisanPayout_grossAmount_idx" ON "ArtisanPayout"("grossAmount");

-- CreateIndex
CREATE INDEX "ArtisanPayout_netAmount_idx" ON "ArtisanPayout"("netAmount");

-- CreateIndex
CREATE INDEX "ArtisanPayout_paidAt_idx" ON "ArtisanPayout"("paidAt");

-- CreateIndex
CREATE INDEX "ArtisanPayout_createdAt_idx" ON "ArtisanPayout"("createdAt");

-- CreateIndex
CREATE INDEX "ArtisanPayoutItem_payoutId_idx" ON "ArtisanPayoutItem"("payoutId");

-- CreateIndex
CREATE INDEX "ArtisanPayoutItem_financialId_idx" ON "ArtisanPayoutItem"("financialId");

-- CreateIndex
CREATE INDEX "ArtisanPayoutItem_interventionId_idx" ON "ArtisanPayoutItem"("interventionId");

-- CreateIndex
CREATE INDEX "ArtisanPayoutItem_amount_idx" ON "ArtisanPayoutItem"("amount");

-- CreateIndex
CREATE INDEX "ArtisanPayoutItem_createdAt_idx" ON "ArtisanPayoutItem"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ArtisanPayoutItem_payoutId_financialId_key" ON "ArtisanPayoutItem"("payoutId", "financialId");

-- CreateIndex
CREATE INDEX "BusinessReport_periodStart_idx" ON "BusinessReport"("periodStart");

-- CreateIndex
CREATE INDEX "BusinessReport_periodEnd_idx" ON "BusinessReport"("periodEnd");

-- CreateIndex
CREATE INDEX "BusinessReport_label_idx" ON "BusinessReport"("label");

-- CreateIndex
CREATE INDEX "BusinessReport_currency_idx" ON "BusinessReport"("currency");

-- CreateIndex
CREATE INDEX "BusinessReport_createdById_idx" ON "BusinessReport"("createdById");

-- CreateIndex
CREATE INDEX "BusinessReport_createdAt_idx" ON "BusinessReport"("createdAt");

-- CreateIndex
CREATE INDEX "AccountingExport_periodStart_idx" ON "AccountingExport"("periodStart");

-- CreateIndex
CREATE INDEX "AccountingExport_periodEnd_idx" ON "AccountingExport"("periodEnd");

-- CreateIndex
CREATE INDEX "AccountingExport_format_idx" ON "AccountingExport"("format");

-- CreateIndex
CREATE INDEX "AccountingExport_status_idx" ON "AccountingExport"("status");

-- CreateIndex
CREATE INDEX "AccountingExport_generatedById_idx" ON "AccountingExport"("generatedById");

-- CreateIndex
CREATE INDEX "AccountingExport_createdAt_idx" ON "AccountingExport"("createdAt");

-- AddForeignKey
ALTER TABLE "InterventionFinancials" ADD CONSTRAINT "InterventionFinancials_interventionId_fkey" FOREIGN KEY ("interventionId") REFERENCES "Intervention"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtisanPayout" ADD CONSTRAINT "ArtisanPayout_artisanId_fkey" FOREIGN KEY ("artisanId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtisanPayoutItem" ADD CONSTRAINT "ArtisanPayoutItem_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "ArtisanPayout"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtisanPayoutItem" ADD CONSTRAINT "ArtisanPayoutItem_financialId_fkey" FOREIGN KEY ("financialId") REFERENCES "InterventionFinancials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessReport" ADD CONSTRAINT "BusinessReport_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountingExport" ADD CONSTRAINT "AccountingExport_generatedById_fkey" FOREIGN KEY ("generatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
