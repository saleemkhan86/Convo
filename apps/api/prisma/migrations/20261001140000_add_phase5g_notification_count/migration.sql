-- Phase 5G: collapsed notification count

ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "count" INTEGER NOT NULL DEFAULT 1;
