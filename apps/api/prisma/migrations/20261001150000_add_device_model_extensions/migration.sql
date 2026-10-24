-- AlterTable: extend Device model for WhatsApp-style multi-device architecture
-- Adds device naming, status tracking, E2EE public key, and sync cursor.

-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- AlterTable
ALTER TABLE "Device"
ADD COLUMN "deviceName" VARCHAR(128),
ADD COLUMN "status" "DeviceStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN "publicKey" BYTEA,
ADD COLUMN "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
