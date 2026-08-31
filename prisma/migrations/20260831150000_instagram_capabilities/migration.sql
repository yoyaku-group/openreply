-- Replace the ambiguous scopes[] cache with per-feature capability evidence.
CREATE TYPE "InstagramCapabilityKind" AS ENUM (
  'BASIC',
  'COMMENTS',
  'MESSAGES',
  'INSIGHTS',
  'CONTENT_PUBLISH'
);

CREATE TYPE "InstagramCapabilityStatus" AS ENUM (
  'UNKNOWN',
  'READY',
  'BLOCKED',
  'ERROR',
  'STALE'
);

ALTER TABLE "InstagramAccount"
  ADD COLUMN "subscribedFields" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "subscriptionCheckedAt" TIMESTAMP(3),
  ADD COLUMN "lastCommentWebhookAt" TIMESTAMP(3),
  ADD COLUMN "lastMessageWebhookAt" TIMESTAMP(3);

CREATE TABLE "InstagramCapability" (
  "id" TEXT NOT NULL,
  "instagramAccountId" TEXT NOT NULL,
  "kind" "InstagramCapabilityKind" NOT NULL,
  "status" "InstagramCapabilityStatus" NOT NULL DEFAULT 'UNKNOWN',
  "reason" TEXT,
  "evidence" JSONB,
  "checkedAt" TIMESTAMP(3),
  "lastSuccessAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "InstagramCapability_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InstagramCapability_instagramAccountId_kind_key"
  ON "InstagramCapability"("instagramAccountId", "kind");
CREATE INDEX "InstagramCapability_status_idx"
  ON "InstagramCapability"("status");
CREATE INDEX "InstagramCapability_kind_status_idx"
  ON "InstagramCapability"("kind", "status");

ALTER TABLE "InstagramCapability"
  ADD CONSTRAINT "InstagramCapability_instagramAccountId_fkey"
  FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed only facts the old cache could prove. Subscription fields are not
-- backfilled from webhookSubscribed because a historical POST acknowledgement
-- is not equivalent to a current GET verification.
INSERT INTO "InstagramCapability" (
  "id", "instagramAccountId", "kind", "status", "reason", "evidence",
  "checkedAt", "lastSuccessAt", "createdAt", "updatedAt"
)
SELECT
  'cap_' || md5(a."id" || ':' || k.kind::text),
  a."id",
  k.kind,
  CASE
    WHEN (k.kind = 'BASIC' AND 'instagram_business_basic' = ANY(a."scopes"))
      OR (k.kind = 'COMMENTS' AND 'instagram_business_manage_comments' = ANY(a."scopes"))
      OR (k.kind = 'MESSAGES' AND 'instagram_business_manage_messages' = ANY(a."scopes"))
      OR (k.kind = 'INSIGHTS' AND 'instagram_business_manage_insights' = ANY(a."scopes"))
    THEN 'READY'::"InstagramCapabilityStatus"
    ELSE 'UNKNOWN'::"InstagramCapabilityStatus"
  END,
  CASE
    WHEN (k.kind = 'BASIC' AND 'instagram_business_basic' = ANY(a."scopes"))
      OR (k.kind = 'COMMENTS' AND 'instagram_business_manage_comments' = ANY(a."scopes"))
      OR (k.kind = 'MESSAGES' AND 'instagram_business_manage_messages' = ANY(a."scopes"))
      OR (k.kind = 'INSIGHTS' AND 'instagram_business_manage_insights' = ANY(a."scopes"))
    THEN 'LEGACY_SCOPE_CACHE'
    ELSE 'NOT_PROBED'
  END,
  jsonb_build_object('source', 'scopes[] migration'),
  a."lastScopeProbeAt",
  CASE
    WHEN (k.kind = 'BASIC' AND 'instagram_business_basic' = ANY(a."scopes"))
      OR (k.kind = 'COMMENTS' AND 'instagram_business_manage_comments' = ANY(a."scopes"))
      OR (k.kind = 'MESSAGES' AND 'instagram_business_manage_messages' = ANY(a."scopes"))
      OR (k.kind = 'INSIGHTS' AND 'instagram_business_manage_insights' = ANY(a."scopes"))
    THEN a."lastScopeProbeAt"
    ELSE NULL
  END,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "InstagramAccount" a
CROSS JOIN unnest(enum_range(NULL::"InstagramCapabilityKind")) AS k(kind);
