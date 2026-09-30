-- AlterTable: per-viewer chat controls (WhatsApp parity, Phase 5A)
ALTER TABLE "ConversationMember" ADD COLUMN     "clearedAt" TIMESTAMP(3),
ADD COLUMN     "hidden" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hiddenAt" TIMESTAMP(3);

-- CreateTable: starred messages (per-account bookmarks)
CREATE TABLE "StarredMessage" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StarredMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StarredMessage_messageId_userId_key" ON "StarredMessage"("messageId", "userId");

-- CreateIndex
CREATE INDEX "StarredMessage_userId_createdAt_idx" ON "StarredMessage"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "StarredMessage" ADD CONSTRAINT "StarredMessage_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StarredMessage" ADD CONSTRAINT "StarredMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
