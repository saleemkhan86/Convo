-- CreateEnum
CREATE TYPE "NotifyMode" AS ENUM ('ALL', 'MENTIONS_ONLY', 'NOTHING');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'MENTION';
ALTER TYPE "NotificationType" ADD VALUE 'CALL_MISSED';

-- AlterTable
ALTER TABLE "ConversationMember" ADD COLUMN     "notifyMode" "NotifyMode" NOT NULL DEFAULT 'ALL',
ADD COLUMN     "notifySound" VARCHAR(64),
ADD COLUMN     "wallpaperKey" VARCHAR(128);

-- AlterTable
ALTER TABLE "Device" ADD COLUMN     "pushEndpoint" VARCHAR(700),
ADD COLUMN     "pushKeys" JSONB;

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "actorId" TEXT,
ADD COLUMN     "callId" TEXT,
ADD COLUMN     "dedupeKey" VARCHAR(128),
ADD COLUMN     "dismissedAt" TIMESTAMP(3),
ADD COLUMN     "messageId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "notifyMuted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "notifyPreview" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "notifyQuietEnd" VARCHAR(5),
ADD COLUMN     "notifyQuietStart" VARCHAR(5),
ADD COLUMN     "notifyQuietTz" VARCHAR(64),
ADD COLUMN     "notifySound" VARCHAR(64),
ADD COLUMN     "wallpaperKey" VARCHAR(128);

-- CreateTable
CREATE TABLE "ChatFolder" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" VARCHAR(48) NOT NULL,
    "emoji" VARCHAR(16),
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatFolder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatFolderItem" (
    "id" TEXT NOT NULL,
    "folderId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatFolderItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatFolder_userId_position_idx" ON "ChatFolder"("userId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ChatFolder_userId_name_key" ON "ChatFolder"("userId", "name");

-- CreateIndex
CREATE INDEX "ChatFolderItem_folderId_idx" ON "ChatFolderItem"("folderId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatFolderItem_folderId_conversationId_key" ON "ChatFolderItem"("folderId", "conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "Device_userId_pushEndpoint_key" ON "Device"("userId", "pushEndpoint");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_createdAt_idx" ON "Notification"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_userId_dedupeKey_key" ON "Notification"("userId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "ChatFolder" ADD CONSTRAINT "ChatFolder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatFolderItem" ADD CONSTRAINT "ChatFolderItem_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "ChatFolder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatFolderItem" ADD CONSTRAINT "ChatFolderItem_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

