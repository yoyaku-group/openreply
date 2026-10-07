-- Plan delegated-roaming-turing F — at most one follow-up per DM.
-- Additive: one nullable column.

ALTER TABLE "DmLog" ADD COLUMN "followUpSentAt" TIMESTAMP(3);
