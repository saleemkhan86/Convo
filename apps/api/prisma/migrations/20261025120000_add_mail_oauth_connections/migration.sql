-- Mail providers (Option B): OAuth connections, state, handoff, send outbox.

-- CreateEnum
CREATE TYPE "MailProvider" AS ENUM ('GOOGLE', 'MICROSOFT');

-- CreateEnum
CREATE TYPE "MailConnectionStatus" AS ENUM ('CONNECTED', 'NEEDS_REAUTH', 'REVOKED', 'ERROR');

-- CreateEnum
CREATE TYPE "MailOAuthPurpose" AS ENUM ('SIGN_IN', 'CONNECT');

-- CreateEnum
CREATE TYPE "EmailVerificationMethod" AS ENUM ('OTP', 'OAUTH');

-- CreateEnum
CREATE TYPE "MailSendJobStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED', 'CANCELLED');

-- AlterEnum: rename in place so existing rows keep their value.
ALTER TYPE "MailRoute" RENAME VALUE 'EXTERNAL_SMTP' TO 'EXTERNAL_PROVIDER';

-- AlterEnum: keep this in its own statement; new value is not used below.
ALTER TYPE "EmailStatus" ADD VALUE 'PARTIAL';

-- AlterTable
ALTER TABLE "EmailIdentity" ADD COLUMN "verificationMethod" "EmailVerificationMethod" NOT NULL DEFAULT 'OTP';

-- AlterTable
ALTER TABLE "EmailRecipient" ALTER COLUMN "route" SET DEFAULT 'EXTERNAL_PROVIDER',
ADD COLUMN "diagnostic" TEXT;

-- AlterTable
ALTER TABLE "EmailThread" ADD COLUMN "providerThreadId" VARCHAR(255);

-- AlterTable
ALTER TABLE "EmailMessage" ADD COLUMN "provider" "MailProvider",
ADD COLUMN "providerThreadId" VARCHAR(255),
ADD COLUMN "isBounce" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "EmailDeliveryEvent" ADD COLUMN "providerEventId" VARCHAR(255),
ADD COLUMN "recipientAddress" VARCHAR(320);

-- CreateTable
CREATE TABLE "MailConnection" (
    "id" TEXT NOT NULL,
    "emailIdentityId" TEXT NOT NULL,
    "provider" "MailProvider" NOT NULL,
    "providerAccountId" VARCHAR(255) NOT NULL,
    "emailAddress" VARCHAR(320) NOT NULL,
    "displayName" VARCHAR(128),
    "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "accessTokenCiphertext" BYTEA,
    "accessTokenIv" BYTEA,
    "accessTokenTag" BYTEA,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenCiphertext" BYTEA,
    "refreshTokenIv" BYTEA,
    "refreshTokenTag" BYTEA,
    "tokenKeyVersion" INTEGER NOT NULL DEFAULT 1,
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "status" "MailConnectionStatus" NOT NULL DEFAULT 'CONNECTED',
    "statusReason" VARCHAR(255),
    "lastRefreshedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "lastSyncError" TEXT,
    "syncCursor" TEXT,
    "syncCursorAt" TIMESTAMP(3),
    "initialSyncDone" BOOLEAN NOT NULL DEFAULT false,
    "watchExpiresAt" TIMESTAMP(3),
    "subscriptionId" VARCHAR(255),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailOAuthState" (
    "id" TEXT NOT NULL,
    "stateHash" VARCHAR(64) NOT NULL,
    "purpose" "MailOAuthPurpose" NOT NULL,
    "provider" "MailProvider" NOT NULL,
    "userId" TEXT,
    "nonce" VARCHAR(128) NOT NULL,
    "codeVerifierCiphertext" BYTEA NOT NULL,
    "codeVerifierIv" BYTEA NOT NULL,
    "codeVerifierTag" BYTEA NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "client" VARCHAR(16) NOT NULL DEFAULT 'web',
    "redirectAfter" VARCHAR(2048),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailOAuthState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthHandoff" (
    "id" TEXT NOT NULL,
    "codeHash" VARCHAR(64) NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthHandoff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailSendJob" (
    "id" TEXT NOT NULL,
    "emailMessageId" TEXT NOT NULL,
    "status" "MailSendJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" VARCHAR(64),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailSendJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MailConnection_emailIdentityId_key" ON "MailConnection"("emailIdentityId");

-- CreateIndex
CREATE UNIQUE INDEX "MailConnection_provider_providerAccountId_key" ON "MailConnection"("provider", "providerAccountId");

-- CreateIndex
CREATE INDEX "MailConnection_status_watchExpiresAt_idx" ON "MailConnection"("status", "watchExpiresAt");

-- CreateIndex
CREATE INDEX "MailConnection_lastSyncedAt_idx" ON "MailConnection"("lastSyncedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MailOAuthState_stateHash_key" ON "MailOAuthState"("stateHash");

-- CreateIndex
CREATE INDEX "MailOAuthState_expiresAt_idx" ON "MailOAuthState"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AuthHandoff_codeHash_key" ON "AuthHandoff"("codeHash");

-- CreateIndex
CREATE INDEX "AuthHandoff_expiresAt_idx" ON "AuthHandoff"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "MailSendJob_emailMessageId_key" ON "MailSendJob"("emailMessageId");

-- CreateIndex
CREATE INDEX "MailSendJob_status_nextAttemptAt_idx" ON "MailSendJob"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "EmailThread_ownerId_providerThreadId_idx" ON "EmailThread"("ownerId", "providerThreadId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailMessage_ownerId_providerMessageId_key" ON "EmailMessage"("ownerId", "providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailDeliveryEvent_provider_providerEventId_key" ON "EmailDeliveryEvent"("provider", "providerEventId");

-- AddForeignKey
ALTER TABLE "MailConnection" ADD CONSTRAINT "MailConnection_emailIdentityId_fkey" FOREIGN KEY ("emailIdentityId") REFERENCES "EmailIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthHandoff" ADD CONSTRAINT "AuthHandoff_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailSendJob" ADD CONSTRAINT "MailSendJob_emailMessageId_fkey" FOREIGN KEY ("emailMessageId") REFERENCES "EmailMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
