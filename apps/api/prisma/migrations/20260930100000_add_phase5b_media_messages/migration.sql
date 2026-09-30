-- Phase 5B: media messages (WhatsApp parity) — attachments on sends, view-once,
-- forwarding, reply snapshots, and upload ownership binding.

-- AlterTable: media markers on Message
ALTER TABLE "Message" ADD COLUMN     "forwardedFromUserId" TEXT,
ADD COLUMN     "replyPreview" JSONB,
ADD COLUMN     "viewOnce" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex: gallery queries filter by message type inside one conversation
CREATE INDEX "Message_conversationId_type_idx" ON "Message"("conversationId", "type");

-- CreateIndex
CREATE INDEX "Message_forwardedFromUserId_idx" ON "Message"("forwardedFromUserId");

-- CreateIndex: attachment rows are always loaded through their message
CREATE INDEX "Attachment_messageId_idx" ON "Attachment"("messageId");

-- CreateTable: uploader-bound media (a storageKey is only attachable by its owner)
CREATE TABLE "MediaObject" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" VARCHAR(128) NOT NULL,
    "kind" "AttachmentKind" NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaObject_pkey" PRIMARY KEY ("id")
);

-- CreateTable: view-once opens, one per (message, viewer)
CREATE TABLE "ViewOnceView" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "viewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ViewOnceView_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MediaObject_storageKey_key" ON "MediaObject"("storageKey");

-- CreateIndex
CREATE INDEX "MediaObject_ownerId_createdAt_idx" ON "MediaObject"("ownerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ViewOnceView_messageId_userId_key" ON "ViewOnceView"("messageId", "userId");

-- CreateIndex
CREATE INDEX "ViewOnceView_userId_idx" ON "ViewOnceView"("userId");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_forwardedFromUserId_fkey" FOREIGN KEY ("forwardedFromUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaObject" ADD CONSTRAINT "MediaObject_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ViewOnceView" ADD CONSTRAINT "ViewOnceView_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ViewOnceView" ADD CONSTRAINT "ViewOnceView_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
