-- Calendar intent provenance and reversible cleanup of generated drafts.
ALTER TABLE "Automation"
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "lifecycle" TEXT NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "publicationKey" TEXT,
  ADD COLUMN "calendarEventId" TEXT,
  ADD COLUMN "calendarScheduledAt" TIMESTAMP(3),
  ADD COLUMN "sourceWorkspaceKey" TEXT,
  ADD COLUMN "archivedAt" TIMESTAMP(3),
  ADD COLUMN "archivedReason" TEXT;

CREATE UNIQUE INDEX "Automation_publicationKey_key" ON "Automation"("publicationKey");
CREATE INDEX "Automation_source_lifecycle_idx" ON "Automation"("source", "lifecycle");
CREATE INDEX "Automation_calendarEventId_idx" ON "Automation"("calendarEventId");

UPDATE "Automation" AS automation
   SET "source" = 'RELEASE_SYNC'
 WHERE EXISTS (
   SELECT 1 FROM "ReleaseSyncEvent" AS event
    WHERE event."automationId" = automation.id
 );

-- Soft-archive only inactive, unused generator output. Manual campaigns and
-- anything with DM history are deliberately excluded.
UPDATE "Automation" AS automation
   SET "lifecycle" = 'ARCHIVED',
       "archivedAt" = CURRENT_TIMESTAMP,
       "archivedReason" = 'legacy_release_sync_cleanup_2026_08_28',
       "isActive" = false,
       "pendingNextReel" = false
 WHERE automation."source" = 'RELEASE_SYNC'
   AND automation."isActive" = false
   AND NOT EXISTS (
     SELECT 1 FROM "DmLog" AS log WHERE log."automationId" = automation.id
   );
