-- Phase 5E: pinned messages (one row per pinned message, shared by the whole chat)

-- CreateTable
CREATE TABLE "MessagePin" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "pinnedById" TEXT NOT NULL,
    "pinnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessagePin_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MessagePin_messageId_key" ON "MessagePin"("messageId");

-- CreateIndex
CREATE INDEX "MessagePin_pinnedById_idx" ON "MessagePin"("pinnedById");

-- AddForeignKey
ALTER TABLE "MessagePin" ADD CONSTRAINT "MessagePin_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessagePin" ADD CONSTRAINT "MessagePin_pinnedById_fkey" FOREIGN KEY ("pinnedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
