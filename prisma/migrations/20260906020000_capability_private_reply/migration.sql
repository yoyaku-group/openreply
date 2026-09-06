-- P1-3a — event-sourced PRIVATE_REPLY capability.
--
-- Adds the enum value written by the DM worker on a real successful private
-- reply (proven transport), distinct from the probe-driven capabilities. The
-- value is only ADDED here and used at runtime, never within this migration, so
-- it is safe inside Prisma's migration transaction on PostgreSQL 12+ (prod runs
-- 16.15). Idempotent via IF NOT EXISTS.
ALTER TYPE "InstagramCapabilityKind" ADD VALUE IF NOT EXISTS 'PRIVATE_REPLY';
