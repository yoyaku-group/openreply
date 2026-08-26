-- Add exact inbound-DM campaigns without changing existing comment campaigns.
CREATE TYPE "AutomationTriggerType" AS ENUM ('COMMENT', 'INBOUND_DM');

ALTER TABLE "Automation"
ADD COLUMN "triggerType" "AutomationTriggerType" NOT NULL DEFAULT 'COMMENT';

CREATE INDEX "Automation_instagramAccountId_triggerType_isActive_idx"
ON "Automation"("instagramAccountId", "triggerType", "isActive");

ALTER TYPE "DmStatus" ADD VALUE 'SENDING';
ALTER TYPE "DmStatus" ADD VALUE 'SKIPPED_WINDOW_EXPIRED';
