-- AI copywriter: editable prompts and the generation queue the host worker
-- drains through /api/internal/copywriter/*. Additive only; rollback is
-- revert + drop the two tables.

CREATE TYPE "CopyGenerationState" AS ENUM (
  'PENDING',
  'CLAIMED',
  'DONE',
  'FAILED'
);

CREATE TABLE "CopywriterPrompt" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "body" TEXT NOT NULL,
  "model" TEXT NOT NULL DEFAULT 'haiku',
  "isActive" BOOLEAN NOT NULL,
  "authorEmail" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CopywriterPrompt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CopyGeneration" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "automationId" TEXT,
  "promptId" TEXT NOT NULL,
  "promptVersion" INTEGER NOT NULL,
  "input" JSONB NOT NULL,
  "renderedPrompt" TEXT NOT NULL,
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "status" "CopyGenerationState" NOT NULL DEFAULT 'PENDING',
  "leaseOwner" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "rawOutput" TEXT,
  "output" JSONB,
  "lintErrors" JSONB,
  "tier" TEXT,
  "latencyMs" INTEGER,
  "failureCode" TEXT,
  "standardCopy" JSONB NOT NULL,
  "appliedAt" TIMESTAMP(3),
  "finalCopy" JSONB,
  "editDistance" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CopyGeneration_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CopywriterPrompt_workspaceId_version_key"
  ON "CopywriterPrompt"("workspaceId", "version");
-- At most one active prompt per workspace. Prisma's DSL cannot express the
-- WHERE clause; service code deactivates the previous active row inside a
-- transaction, this index is the race-proof backstop.
CREATE UNIQUE INDEX "CopywriterPrompt_one_active_per_workspace"
  ON "CopywriterPrompt"("workspaceId")
  WHERE "isActive";

CREATE INDEX "CopyGeneration_status_createdAt_idx"
  ON "CopyGeneration"("status", "createdAt");
CREATE INDEX "CopyGeneration_workspaceId_createdAt_idx"
  ON "CopyGeneration"("workspaceId", "createdAt");
CREATE INDEX "CopyGeneration_automationId_idx"
  ON "CopyGeneration"("automationId");

ALTER TABLE "CopywriterPrompt"
  ADD CONSTRAINT "CopywriterPrompt_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CopyGeneration"
  ADD CONSTRAINT "CopyGeneration_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CopyGeneration"
  ADD CONSTRAINT "CopyGeneration_promptId_fkey"
  FOREIGN KEY ("promptId") REFERENCES "CopywriterPrompt"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
