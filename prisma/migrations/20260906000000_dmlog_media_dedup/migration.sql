-- Per-user/media idempotence for comment→DM: a commenter only triggers a DM on
-- their first comment under a post. Additive + forward-only (rules/25).
ALTER TABLE "DmLog" ADD COLUMN "mediaId" TEXT;

CREATE INDEX "DmLog_automationId_mediaId_commenterId_idx" ON "DmLog"("automationId", "mediaId", "commenterId");
