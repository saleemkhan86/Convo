# Database drift

Generated 2026-10-23 with `prisma migrate diff` (offline — schema file to schema file, no DB writes) and verified against the live database with read-only catalog queries.

## The drift

`apps/api/prisma/schema.prisma` and three migration folders are **uncommitted working-tree changes**, but they are **already applied** to the Supabase development database. Git is behind the database.

Verified in `_prisma_migrations` (all `done=true`, `applied_steps_count=1`):

```
20261001150000_add_device_model_extensions
20261001160000_add_message_sequence_number
20261001170000_add_device_message_delivery
```

Consequences:

- `prisma migrate deploy` against **this** database is a no-op — the ledger already has these rows.
- Against a **fresh** database, those three folders must be committed first, or the new environment gets a schema that the code does not match.
- Committing the working tree without the migration folders would leave every future environment broken. This is the main reason the WIP should land soon.

## SQL that git does not contain yet

This is the full delta from `HEAD:apps/api/prisma/schema.prisma` to the working-tree schema — i.e. what a fresh environment needs beyond the committed migrations. The same statements already exist in the three untracked folders above; `sequenceNumber` is added nullable, backfilled per conversation in `createdAt` order, then `SET NOT NULL`, so it is safe on a non-empty `Message` table.

```sql
-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- AlterTable
ALTER TABLE "Device" ADD COLUMN     "deviceName" VARCHAR(128),
ADD COLUMN     "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "publicKey" BYTEA,
ADD COLUMN     "status" "DeviceStatus" NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "sequenceNumber" INTEGER NOT NULL;

-- CreateTable
CREATE TABLE "DeviceMessageDelivery" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "sequenceNumber" INTEGER NOT NULL,
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceMessageDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeviceMessageDelivery_deviceId_sequenceNumber_idx" ON "DeviceMessageDelivery"("deviceId", "sequenceNumber");

-- CreateIndex
CREATE INDEX "DeviceMessageDelivery_messageId_idx" ON "DeviceMessageDelivery"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceMessageDelivery_deviceId_messageId_key" ON "DeviceMessageDelivery"("deviceId", "messageId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_conversationId_sequenceNumber_key" ON "Message"("conversationId", "sequenceNumber");

-- AddForeignKey
ALTER TABLE "DeviceMessageDelivery" ADD CONSTRAINT "DeviceMessageDelivery_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceMessageDelivery" ADD CONSTRAINT "DeviceMessageDelivery_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

Note: a fresh database must run the nullable-then-backfill form in `20261001160000_add_message_sequence_number/migration.sql` rather than the `NOT NULL` line above; `ADD COLUMN ... NOT NULL` without a default fails on a populated table. Prefer `pnpm prisma:deploy` over pasting this.

## Indexes that do not exist anywhere yet

Confirmed by `pg_indexes` on the live database — these are absent from both the database and `schema.prisma`. Each is a **proposed** change: confirm the query path actually filters on the column before adding it, since every index is write amplification on a chat workload.

| Table | Existing indexes | Gap |
|---|---|---|
| `MessageReceipt` | `pkey`, `messageId_userId` unique | no index led with `userId`; receipt updates and unread counts key on `userId` |
| `Contact` | `pkey`, `ownerId`, `ownerId_email` unique, `ownerId_phone` unique | no index on `convoUserId` |
| `Call` | `pkey`, `callerId_createdAt`, `conversationId_createdAt` | no index on `status`; the ring sweep filters `status = 'RINGING'` (0 rows today, so harmless now) |
| `Attachment` | `pkey`, `messageId`, `storageKey` | no index on `emailMessageId` |
| `VerificationChallenge` | `pkey`, `target_purpose_createdAt` | no index on `codeHash` — **no code path looks a challenge up by hash**, so this index is not needed today |
