-- Ephemeral Instagram transport/review state. Customer communication remains
-- in Gmail and SAV lifecycle state remains in YOFR.
CREATE TYPE "SavTransportState" AS ENUM (
  'PENDING',
  'CLAIMED',
  'REVIEWED',
  'SENDING',
  'SENT',
  'HOLD',
  'FAILED'
);

CREATE TABLE "SavConversationFence" (
  "id" TEXT NOT NULL,
  "instagramAccountId" TEXT NOT NULL,
  "senderInstagramId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "latestMetaMessageId" TEXT NOT NULL,
  "latestReceivedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SavConversationFence_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SavTransportItem" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "instagramAccountId" TEXT NOT NULL,
  "accountInstagramId" TEXT NOT NULL,
  "accountUsername" TEXT NOT NULL,
  "senderInstagramId" TEXT NOT NULL,
  "senderUsername" TEXT,
  "conversationKey" TEXT NOT NULL,
  "graphConversationId" TEXT,
  "conversationRevision" INTEGER NOT NULL,
  "metaMessageId" TEXT NOT NULL,
  "messageCiphertext" TEXT NOT NULL,
  "messageFingerprint" TEXT NOT NULL,
  "contextCiphertext" TEXT,
  "contextFingerprint" TEXT,
  "hasAttachments" BOOLEAN NOT NULL DEFAULT false,
  "receivedAt" TIMESTAMP(3) NOT NULL,
  "replyWindowExpiresAt" TIMESTAMP(3) NOT NULL,
  "state" "SavTransportState" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "claimWorkerId" TEXT,
  "claimTokenHash" TEXT,
  "claimExpiresAt" TIMESTAMP(3),
  "reviewedAt" TIMESTAMP(3),
  "failureCode" TEXT,
  "deliveryTokenHash" TEXT,
  "deliveryTokenExpiresAt" TIMESTAMP(3),
  "deliveryIdempotencyKey" TEXT,
  "outboundFingerprint" TEXT,
  "metaReplyMessageId" TEXT,
  "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SavTransportItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SavConversationFence_instagramAccountId_senderInstagramId_key"
  ON "SavConversationFence"("instagramAccountId", "senderInstagramId");
CREATE INDEX "SavConversationFence_updatedAt_idx" ON "SavConversationFence"("updatedAt");

CREATE UNIQUE INDEX "SavTransportItem_metaMessageId_key" ON "SavTransportItem"("metaMessageId");
CREATE UNIQUE INDEX "SavTransportItem_deliveryIdempotencyKey_key" ON "SavTransportItem"("deliveryIdempotencyKey");
CREATE INDEX "SavTransportItem_state_receivedAt_idx" ON "SavTransportItem"("state", "receivedAt");
CREATE INDEX "SavTransportItem_instagramAccountId_senderInstagramId_receivedAt_idx"
  ON "SavTransportItem"("instagramAccountId", "senderInstagramId", "receivedAt");
CREATE INDEX "SavTransportItem_claimExpiresAt_idx" ON "SavTransportItem"("claimExpiresAt");
CREATE INDEX "SavTransportItem_updatedAt_idx" ON "SavTransportItem"("updatedAt");

ALTER TABLE "SavConversationFence"
  ADD CONSTRAINT "SavConversationFence_instagramAccountId_fkey"
  FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SavTransportItem"
  ADD CONSTRAINT "SavTransportItem_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SavTransportItem"
  ADD CONSTRAINT "SavTransportItem_instagramAccountId_fkey"
  FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
