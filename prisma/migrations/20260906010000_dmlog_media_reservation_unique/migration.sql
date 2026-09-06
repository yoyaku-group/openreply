-- P1-2b — race-proof per-user/media DM idempotence.
--
-- Enforces "at most one live DM reservation per (automationId, mediaId,
-- commenterId)" via a PARTIAL UNIQUE INDEX over the reserved status set
-- {SENDING, SENT}. This is the DB-level backstop to the read-then-act pre-filter
-- in dm-worker.ts; the worker's PENDING->SENDING claim relies on it (a losing
-- concurrent comment gets P2002 -> SKIPPED_DEDUP, no DM sent).
--
-- Prisma note: partial unique indexes are not expressible in the schema DSL, so
-- this migration is raw SQL. `prisma migrate deploy` (prod) applies it without a
-- drift check; `prisma migrate dev` (local) will report it as drift on a later
-- schema change — expected, do not drop it.
--
-- rules/25: forward-only + additive. The whole migration runs in one Prisma
-- transaction: if the CREATE UNIQUE INDEX below fails on unexpected duplicate
-- data, the dedup UPDATE rolls back with it — no partial/corrupt state.

-- Step 1 — resolve any pre-existing duplicate SENT rows (CREATE UNIQUE INDEX
-- fails if data already violates it). Keep the earliest SENT per group; demote
-- the rest to SKIPPED_DEDUP (audit-preserving, never DELETE). Scoped to
-- mediaId IS NOT NULL: NULL mediaId (inbound-DM / legacy rows) are distinct in a
-- Postgres unique index and never collide. Comment rows never held SENDING
-- before this migration, so SENT is the only reserved state needing cleanup.
UPDATE "DmLog" AS d
SET status = 'SKIPPED_DEDUP',
    "errorMessage" = 'Backfill dedup: superseded by an earlier SENT DM for this automation+post (P1-2b)'
FROM (
  SELECT id,
         row_number() OVER (
           PARTITION BY "automationId", "mediaId", "commenterId"
           ORDER BY "createdAt" ASC, id ASC
         ) AS rn
  FROM "DmLog"
  WHERE status = 'SENT' AND "mediaId" IS NOT NULL
) ranked
WHERE d.id = ranked.id AND ranked.rn > 1;

-- Step 2 — the guarantee.
CREATE UNIQUE INDEX "DmLog_reservation_unique"
  ON "DmLog" ("automationId", "mediaId", "commenterId")
  WHERE status IN ('SENDING', 'SENT');
