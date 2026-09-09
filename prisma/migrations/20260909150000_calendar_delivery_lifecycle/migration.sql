-- Additive provenance. Existing Calendar automations need a fresh sync and human review.
ALTER TABLE "Automation"
  ADD COLUMN "sourceRevision" TEXT,
  ADD COLUMN "sourceDeliveryAllowed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "sourceBlockingReasons" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "calendarStatus" TEXT,
  ADD COLUMN "calendarAutomationStatus" TEXT;
UPDATE "Automation" SET "isActive" = false, "lifecycle" = 'PAUSED'
WHERE "source" = 'CALENDAR' AND "isActive" = true;
