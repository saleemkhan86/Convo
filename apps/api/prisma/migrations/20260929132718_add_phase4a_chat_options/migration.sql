-- CreateEnum
CREATE TYPE "PresenceVisibility" AS ENUM ('EVERYONE', 'CONTACTS', 'NONE');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "lastSeenAt" TIMESTAMP(3),
ADD COLUMN     "presenceVisibility" "PresenceVisibility" NOT NULL DEFAULT 'EVERYONE';

-- CreateTable
CREATE TABLE "MessageHidden" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageHidden_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MessageHidden_userId_idx" ON "MessageHidden"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "MessageHidden_messageId_userId_key" ON "MessageHidden"("messageId", "userId");

-- AddForeignKey
ALTER TABLE "MessageHidden" ADD CONSTRAINT "MessageHidden_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageHidden" ADD CONSTRAINT "MessageHidden_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
