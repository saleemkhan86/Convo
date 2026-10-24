-- Add sequence number column (nullable first to allow backfill)
ALTER TABLE "Message" ADD COLUMN "sequenceNumber" INTEGER;

-- Backfill sequence numbers per conversation based on createdAt order
DO $$
DECLARE
    conv_id TEXT;
    seq INTEGER;
    msg_record RECORD;
BEGIN
    FOR conv_id IN SELECT DISTINCT "conversationId" FROM "Message"
    LOOP
        seq := 1;
        FOR msg_record IN
            SELECT id FROM "Message"
            WHERE "conversationId" = conv_id
            ORDER BY "createdAt" ASC, id ASC
        LOOP
            UPDATE "Message" SET "sequenceNumber" = seq WHERE id = msg_record.id;
            seq := seq + 1;
        END LOOP;
    END LOOP;
END $$;

-- Make the column non-nullable now that it's populated
ALTER TABLE "Message" ALTER COLUMN "sequenceNumber" SET NOT NULL;

-- Add unique constraint per conversation
CREATE UNIQUE INDEX "Message_conversationId_sequenceNumber_key" ON "Message"("conversationId", "sequenceNumber");
