-- CreateIndex
CREATE INDEX "Intervention_subServiceId_idx" ON "Intervention"("subServiceId");

-- CreateIndex
CREATE INDEX "ServiceCategory_serviceType_idx" ON "ServiceCategory"("serviceType");

-- CreateIndex
CREATE INDEX "ServiceCategory_isActive_idx" ON "ServiceCategory"("isActive");

-- CreateIndex
CREATE INDEX "ServiceCategory_name_idx" ON "ServiceCategory"("name");

-- CreateIndex
CREATE INDEX "SubService_isActive_idx" ON "SubService"("isActive");

-- CreateIndex
CREATE INDEX "SubService_name_idx" ON "SubService"("name");

-- CreateIndex
CREATE INDEX "SubService_basePrice_idx" ON "SubService"("basePrice");

-- CreateIndex
CREATE INDEX "SubService_emergencyPrice_idx" ON "SubService"("emergencyPrice");

-- CreateIndex
CREATE INDEX "SubService_estimatedDuration_idx" ON "SubService"("estimatedDuration");
