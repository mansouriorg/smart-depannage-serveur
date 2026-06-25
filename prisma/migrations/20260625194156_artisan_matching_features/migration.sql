-- AlterTable
ALTER TABLE "ArtisanProfile" ADD COLUMN     "averageResponseMinutes" INTEGER,
ADD COLUMN     "emergencyAvailable" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "maxActiveJobs" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "serviceTypes" "ServiceType"[] DEFAULT ARRAY[]::"ServiceType"[];

-- CreateIndex
CREATE INDEX "ArtisanProfile_emergencyAvailable_idx" ON "ArtisanProfile"("emergencyAvailable");

-- CreateIndex
CREATE INDEX "ArtisanProfile_maxActiveJobs_idx" ON "ArtisanProfile"("maxActiveJobs");

-- CreateIndex
CREATE INDEX "ArtisanProfile_averageRating_idx" ON "ArtisanProfile"("averageRating");
