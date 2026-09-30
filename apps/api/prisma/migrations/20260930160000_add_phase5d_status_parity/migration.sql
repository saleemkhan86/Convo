-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "statusReplyId" TEXT;

-- AlterTable
ALTER TABLE "Status" ADD COLUMN     "shareReadReceipts" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "StatusMute" (
    "userId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StatusMute_pkey" PRIMARY KEY ("userId","authorId")
);

-- CreateIndex
CREATE INDEX "StatusMute_userId_idx" ON "StatusMute"("userId");

-- CreateIndex
CREATE INDEX "Message_statusReplyId_idx" ON "Message"("statusReplyId");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_statusReplyId_fkey" FOREIGN KEY ("statusReplyId") REFERENCES "Status"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatusMute" ADD CONSTRAINT "StatusMute_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatusMute" ADD CONSTRAINT "StatusMute_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

