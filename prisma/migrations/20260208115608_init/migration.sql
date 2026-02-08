-- CreateEnum
CREATE TYPE "Role" AS ENUM ('CLIENT', 'ARTISAN', 'ADMIN');

-- CreateEnum
CREATE TYPE "ServiceType" AS ENUM ('PLOMBIER', 'MENUISIER', 'SERRURIER', 'ELECTRICIEN', 'AUTRE');

-- CreateEnum
CREATE TYPE "Status" AS ENUM ('PENDING', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT,
    "phone" TEXT,
    "role" "Role" NOT NULL DEFAULT 'CLIENT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Intervention" (
    "id" SERIAL NOT NULL,
    "description" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "serviceType" "ServiceType" NOT NULL,
    "status" "Status" NOT NULL DEFAULT 'PENDING',
    "clientId" INTEGER NOT NULL,
    "artisanId" INTEGER,
    "photos" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Intervention_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- AddForeignKey
ALTER TABLE "Intervention" ADD CONSTRAINT "Intervention_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Intervention" ADD CONSTRAINT "Intervention_artisanId_fkey" FOREIGN KEY ("artisanId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
