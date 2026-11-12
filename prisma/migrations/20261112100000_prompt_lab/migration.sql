-- Prompt lab (lot S4): golden examples on prompt versions and the trial
-- flag for draft-prompt test runs. Additive only; rollback is
-- `ALTER TABLE "CopywriterPrompt" DROP COLUMN "examples";
--  ALTER TABLE "CopyGeneration" DROP COLUMN "isTrial";`

ALTER TABLE "CopywriterPrompt" ADD COLUMN "examples" JSONB;

ALTER TABLE "CopyGeneration" ADD COLUMN "isTrial" BOOLEAN NOT NULL DEFAULT false;
