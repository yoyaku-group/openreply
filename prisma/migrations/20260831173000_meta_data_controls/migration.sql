-- Store both identifiers returned by Instagram Login. The app-scoped ID is
-- required to resolve Meta deauthorization and data-deletion signed requests.
ALTER TABLE "InstagramAccount"
ADD COLUMN "instagramScopedId" TEXT;

CREATE UNIQUE INDEX "InstagramAccount_instagramScopedId_key"
ON "InstagramAccount"("instagramScopedId");

-- Idempotent, non-PII receipts for Meta data-deletion requests.
CREATE TABLE "MetaDataDeletionRequest" (
    "id" TEXT NOT NULL,
    "confirmationCode" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "platformUserIdHash" TEXT NOT NULL,
    "matchedUsername" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PROCESSING',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetaDataDeletionRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MetaDataDeletionRequest_confirmationCode_key"
ON "MetaDataDeletionRequest"("confirmationCode");

CREATE UNIQUE INDEX "MetaDataDeletionRequest_requestFingerprint_key"
ON "MetaDataDeletionRequest"("requestFingerprint");

CREATE INDEX "MetaDataDeletionRequest_status_idx"
ON "MetaDataDeletionRequest"("status");

CREATE INDEX "MetaDataDeletionRequest_requestedAt_idx"
ON "MetaDataDeletionRequest"("requestedAt");
