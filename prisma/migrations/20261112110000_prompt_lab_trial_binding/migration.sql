-- Prompt lab trial binding (lot S4 follow-up): the draft model a trial must
-- run on, and the hash of the draft body the trial was rendered from. Both
-- nullable, trial rows only. Additive only; rollback is
-- `ALTER TABLE "CopyGeneration"
--    DROP COLUMN "modelOverride",
--    DROP COLUMN "trialBodyHash";`

ALTER TABLE "CopyGeneration" ADD COLUMN "modelOverride" TEXT;

ALTER TABLE "CopyGeneration" ADD COLUMN "trialBodyHash" TEXT;
