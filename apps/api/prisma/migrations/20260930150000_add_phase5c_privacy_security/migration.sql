-- Phase 5C: privacy settings, disappearing messages, two-step verification,
-- sessions UI, linked devices, and account-deletion grace.

-- CreateEnum
CREATE TYPE "ProfileVisibility" AS ENUM ('EVERYONE', 'CONTACTS', 'CONTACTS_EXCEPT', 'NONE');

-- CreateEnum
CREATE TYPE "GroupAddVisibility" AS ENUM ('EVERYONE', 'CONTACTS', 'NOBODY');

-- AlterEnum
ALTER TYPE "ChallengePurpose" ADD VALUE 'TWO_FACTOR';

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "ephemeralSeconds" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "expiresAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "aboutVisibility" "ProfileVisibility" NOT NULL DEFAULT 'EVERYONE',
ADD COLUMN     "avatarVisibility" "ProfileVisibility" NOT NULL DEFAULT 'EVERYONE',
ADD COLUMN     "clientSettings" JSONB,
ADD COLUMN     "defaultEphemeralSeconds" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "deletionRequestedAt" TIMESTAMP(3),
ADD COLUMN     "groupAddVisibility" "GroupAddVisibility" NOT NULL DEFAULT 'EVERYONE',
ADD COLUMN     "onlineVisibility" "ProfileVisibility" NOT NULL DEFAULT 'EVERYONE',
ADD COLUMN     "readReceiptsEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "twoFactorHash" TEXT,
ADD COLUMN     "twoFactorSalt" TEXT,
ADD COLUMN     "twoFactorUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "visibilityExcluded" JSONB;

-- CreateIndex
CREATE INDEX "Message_expiresAt_idx" ON "Message"("expiresAt");
