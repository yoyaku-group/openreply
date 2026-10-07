-- Plan delegated-roaming-turing F — attribute a tracked-link click to the DM
-- that delivered it (?d=<dmLogId>), enabling the single ~20h follow-up.
-- Additive: one nullable column + an index.

ALTER TABLE "LinkClick" ADD COLUMN "dmLogId" TEXT;

CREATE INDEX "LinkClick_dmLogId_idx" ON "LinkClick"("dmLogId");
