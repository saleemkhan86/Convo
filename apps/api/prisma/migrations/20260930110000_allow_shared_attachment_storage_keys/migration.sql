-- Phase 5B (follow-up): an attachment row is a *reference* to stored bytes, not
-- the owner of them. Re-sending a file and forwarding a media message both add
-- Attachment rows that point at the same MediaObject key, so the old uniqueness
-- on storageKey has to go (an index keeps the lookup fast).

-- DropIndex
DROP INDEX "Attachment_storageKey_key";

-- CreateIndex
CREATE INDEX "Attachment_storageKey_idx" ON "Attachment"("storageKey");
