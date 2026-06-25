-- CreateEnum
CREATE TYPE "FileAssetPurpose" AS ENUM ('CLIENT_DAMAGE_PHOTO', 'ARTISAN_BEFORE_PHOTO', 'ARTISAN_AFTER_PHOTO', 'ARTISAN_DOCUMENT', 'IDENTITY_DOCUMENT', 'INSURANCE_CERTIFICATE', 'QUOTE_PDF', 'INVOICE_PDF', 'COMPLAINT_ATTACHMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "FileAssetVisibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "StorageProvider" AS ENUM ('LOCAL', 'AWS_S3', 'CLOUDINARY', 'SUPABASE', 'GOOGLE_CLOUD');

-- CreateTable
CREATE TABLE "FileAsset" (
    "id" SERIAL NOT NULL,
    "uploadedById" INTEGER,
    "purpose" "FileAssetPurpose" NOT NULL,
    "visibility" "FileAssetVisibility" NOT NULL DEFAULT 'PRIVATE',
    "storageProvider" "StorageProvider" NOT NULL DEFAULT 'LOCAL',
    "entityType" TEXT,
    "entityId" INTEGER,
    "originalName" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "relativePath" TEXT NOT NULL,
    "publicUrl" TEXT,
    "mimeType" TEXT NOT NULL,
    "extension" TEXT,
    "size" INTEGER NOT NULL,
    "checksum" TEXT,
    "isImage" BOOLEAN NOT NULL DEFAULT false,
    "width" INTEGER,
    "height" INTEGER,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "replacedById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FileAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FileAsset_uploadedById_idx" ON "FileAsset"("uploadedById");

-- CreateIndex
CREATE INDEX "FileAsset_purpose_idx" ON "FileAsset"("purpose");

-- CreateIndex
CREATE INDEX "FileAsset_visibility_idx" ON "FileAsset"("visibility");

-- CreateIndex
CREATE INDEX "FileAsset_storageProvider_idx" ON "FileAsset"("storageProvider");

-- CreateIndex
CREATE INDEX "FileAsset_entityType_idx" ON "FileAsset"("entityType");

-- CreateIndex
CREATE INDEX "FileAsset_entityId_idx" ON "FileAsset"("entityId");

-- CreateIndex
CREATE INDEX "FileAsset_entityType_entityId_idx" ON "FileAsset"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "FileAsset_mimeType_idx" ON "FileAsset"("mimeType");

-- CreateIndex
CREATE INDEX "FileAsset_isDeleted_idx" ON "FileAsset"("isDeleted");

-- CreateIndex
CREATE INDEX "FileAsset_createdAt_idx" ON "FileAsset"("createdAt");

-- AddForeignKey
ALTER TABLE "FileAsset" ADD CONSTRAINT "FileAsset_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileAsset" ADD CONSTRAINT "FileAsset_replacedById_fkey" FOREIGN KEY ("replacedById") REFERENCES "FileAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
