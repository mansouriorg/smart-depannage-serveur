-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('NEW_INTERVENTION_CREATED', 'ARTISAN_ASSIGNED', 'ARTISAN_ACCEPTED_MISSION', 'ARTISAN_ON_THE_WAY', 'ARTISAN_ARRIVED', 'WORK_STARTED', 'WORK_COMPLETED', 'QUOTE_SENT', 'QUOTE_ACCEPTED', 'PAYMENT_RECEIVED', 'INVOICE_READY', 'COMPLAINT_OPENED', 'COMPLAINT_UPDATED', 'ARTISAN_APPLICATION_APPROVED', 'ARTISAN_APPLICATION_REJECTED', 'GENERAL');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL', 'SMS', 'PUSH', 'ADMIN_REAL_TIME');

-- CreateEnum
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "NotificationPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- AlterTable
ALTER TABLE "NotificationPreference" ADD COLUMN     "adminRealtimeEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "artisanAcceptedMission" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "artisanApplicationApproved" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "artisanApplicationRejected" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "artisanArrived" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "artisanAssigned" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "artisanOnTheWay" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "complaintOpened" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "complaintUpdated" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "inAppEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "invoiceReady" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "newInterventionCreated" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "paymentReceived" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "quoteAccepted" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "quoteSent" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "workCompleted" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "workStarted" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "Notification" (
    "id" SERIAL NOT NULL,
    "recipientId" INTEGER NOT NULL,
    "actorId" INTEGER,
    "type" "NotificationType" NOT NULL,
    "priority" "NotificationPriority" NOT NULL DEFAULT 'NORMAL',
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "channels" "NotificationChannel"[],
    "entityType" TEXT,
    "entityId" INTEGER,
    "data" JSONB,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationDeliveryLog" (
    "id" SERIAL NOT NULL,
    "notificationId" INTEGER NOT NULL,
    "userId" INTEGER,
    "channel" "NotificationChannel" NOT NULL,
    "status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "destination" TEXT,
    "provider" TEXT,
    "providerMessageId" TEXT,
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationDeliveryLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushDeviceToken" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT,
    "deviceId" TEXT,
    "deviceName" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PushDeviceToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notification_recipientId_idx" ON "Notification"("recipientId");

-- CreateIndex
CREATE INDEX "Notification_actorId_idx" ON "Notification"("actorId");

-- CreateIndex
CREATE INDEX "Notification_type_idx" ON "Notification"("type");

-- CreateIndex
CREATE INDEX "Notification_priority_idx" ON "Notification"("priority");

-- CreateIndex
CREATE INDEX "Notification_entityType_idx" ON "Notification"("entityType");

-- CreateIndex
CREATE INDEX "Notification_entityId_idx" ON "Notification"("entityId");

-- CreateIndex
CREATE INDEX "Notification_entityType_entityId_idx" ON "Notification"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "Notification_isRead_idx" ON "Notification"("isRead");

-- CreateIndex
CREATE INDEX "Notification_deletedAt_idx" ON "Notification"("deletedAt");

-- CreateIndex
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");

-- CreateIndex
CREATE INDEX "NotificationDeliveryLog_notificationId_idx" ON "NotificationDeliveryLog"("notificationId");

-- CreateIndex
CREATE INDEX "NotificationDeliveryLog_userId_idx" ON "NotificationDeliveryLog"("userId");

-- CreateIndex
CREATE INDEX "NotificationDeliveryLog_channel_idx" ON "NotificationDeliveryLog"("channel");

-- CreateIndex
CREATE INDEX "NotificationDeliveryLog_status_idx" ON "NotificationDeliveryLog"("status");

-- CreateIndex
CREATE INDEX "NotificationDeliveryLog_destination_idx" ON "NotificationDeliveryLog"("destination");

-- CreateIndex
CREATE INDEX "NotificationDeliveryLog_sentAt_idx" ON "NotificationDeliveryLog"("sentAt");

-- CreateIndex
CREATE INDEX "NotificationDeliveryLog_createdAt_idx" ON "NotificationDeliveryLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PushDeviceToken_token_key" ON "PushDeviceToken"("token");

-- CreateIndex
CREATE INDEX "PushDeviceToken_userId_idx" ON "PushDeviceToken"("userId");

-- CreateIndex
CREATE INDEX "PushDeviceToken_token_idx" ON "PushDeviceToken"("token");

-- CreateIndex
CREATE INDEX "PushDeviceToken_platform_idx" ON "PushDeviceToken"("platform");

-- CreateIndex
CREATE INDEX "PushDeviceToken_isActive_idx" ON "PushDeviceToken"("isActive");

-- CreateIndex
CREATE INDEX "PushDeviceToken_lastUsedAt_idx" ON "PushDeviceToken"("lastUsedAt");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDeliveryLog" ADD CONSTRAINT "NotificationDeliveryLog_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDeliveryLog" ADD CONSTRAINT "NotificationDeliveryLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushDeviceToken" ADD CONSTRAINT "PushDeviceToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
