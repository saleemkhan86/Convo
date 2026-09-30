-- CreateEnum
CREATE TYPE "MemberJoinState" AS ENUM ('ACTIVE', 'PENDING', 'REJECTED');

-- CreateEnum
CREATE TYPE "GroupVisibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "GroupPermission" AS ENUM ('ALL', 'ADMINS');

-- CreateEnum
CREATE TYPE "StatusKind" AS ENUM ('TEXT', 'IMAGE', 'VIDEO', 'URL');

-- CreateEnum
CREATE TYPE "StatusVisibility" AS ENUM ('EVERYONE', 'CONTACTS', 'CUSTOM', 'CONTACTS_EXCEPT');

-- AlterEnum
ALTER TYPE "MessageType" ADD VALUE 'STICKER';

-- AlterTable
ALTER TABLE "ConversationMember" ADD COLUMN     "joinState" "MemberJoinState" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "invitedById" TEXT;

-- CreateIndex
CREATE INDEX "ConversationMember_conversationId_joinState_idx" ON "ConversationMember"("conversationId", "joinState");

-- AddForeignKey
ALTER TABLE "ConversationMember" ADD CONSTRAINT "ConversationMember_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "GroupProfile" (
    "conversationId" TEXT NOT NULL,
    "visibility" "GroupVisibility" NOT NULL DEFAULT 'PRIVATE',
    "requireApproval" BOOLEAN NOT NULL DEFAULT false,
    "whoCanSend" "GroupPermission" NOT NULL DEFAULT 'ALL',
    "whoCanEdit" "GroupPermission" NOT NULL DEFAULT 'ADMINS',
    "announceOnly" BOOLEAN NOT NULL DEFAULT false,
    "about" VARCHAR(512),
    "inviteCode" TEXT NOT NULL,
    "inviteRevokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupProfile_pkey" PRIMARY KEY ("conversationId")
);

-- CreateIndex
CREATE UNIQUE INDEX "GroupProfile_inviteCode_key" ON "GroupProfile"("inviteCode");

-- AddForeignKey
ALTER TABLE "GroupProfile" ADD CONSTRAINT "GroupProfile_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "Status" (
    "id" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "kind" "StatusKind" NOT NULL,
    "text" TEXT,
    "storageKey" TEXT,
    "mimeType" VARCHAR(128),
    "visibility" "StatusVisibility" NOT NULL DEFAULT 'EVERYONE',
    "audience" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "excluded" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Status_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatusView" (
    "id" TEXT NOT NULL,
    "statusId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "viewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StatusView_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Status_storageKey_key" ON "Status"("storageKey");

-- CreateIndex
CREATE INDEX "Status_authorId_expiresAt_idx" ON "Status"("authorId", "expiresAt");

-- CreateIndex
CREATE INDEX "Status_expiresAt_idx" ON "Status"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "StatusView_statusId_userId_key" ON "StatusView"("statusId", "userId");

-- CreateIndex
CREATE INDEX "StatusView_statusId_idx" ON "StatusView"("statusId");

-- AddForeignKey
ALTER TABLE "Status" ADD CONSTRAINT "Status_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatusView" ADD CONSTRAINT "StatusView_statusId_fkey" FOREIGN KEY ("statusId") REFERENCES "Status"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatusView" ADD CONSTRAINT "StatusView_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
