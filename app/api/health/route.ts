import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getDMQueue, getRedisConnection } from "@/lib/queue/client";
import { getWorkerHealth } from "@/lib/ops/worker-health";
import {
  listCachedInstagramCapabilities,
  summarizeInstagramCapabilities,
} from "@/lib/meta/capabilities";

export const runtime = "nodejs";
// Health must reflect live state (worker heartbeat, queue depth), never a
// cached response, or it reports stale worker start times.
export const dynamic = "force-dynamic";

type CheckStatus = "ok" | "degraded" | "error";

interface HealthCheck {
  status: CheckStatus;
  detail?: string;
}

async function checkDatabase(): Promise<HealthCheck> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { status: "ok" };
  } catch (error) {
    return {
      status: "error",
      detail: error instanceof Error ? error.message : "Database check failed",
    };
  }
}

async function checkRedis(): Promise<HealthCheck> {
  try {
    const pong = await getRedisConnection().ping();
    return { status: pong === "PONG" ? "ok" : "error", detail: pong };
  } catch (error) {
    return {
      status: "error",
      detail: error instanceof Error ? error.message : "Redis check failed",
    };
  }
}

async function checkQueue(): Promise<HealthCheck & { counts?: unknown }> {
  try {
    const counts = await getDMQueue().getJobCounts(
      "waiting",
      "active",
      "delayed",
      "failed",
    );
    return { status: "ok", counts };
  } catch (error) {
    return {
      status: "error",
      detail: error instanceof Error ? error.message : "Queue check failed",
    };
  }
}

/**
 * Instagram capability check, read-only from the local DB. NO Meta calls.
 *
 * SECURITY: this endpoint is unauthenticated (load-balancer probes), so it
 * MUST NOT trigger live Meta scope probes or expose per-account scope
 * detail — unauthenticated callers would otherwise burn Meta rate limits
 * by spamming the probe and learn which accounts hold which scopes. Per-
 * account detail lives at /api/admin/instagram-capabilities (auth-gated).
 *
 * A `stale` flag tells operators when the cached scope data is too old to
 * be useful — usually that means a scheduled cron probe hasn't run, not
 * that scopes just drifted.
 */
async function checkInstagramCapabilities(): Promise<
  HealthCheck & {
    account_count?: number;
    comment_ready_count?: number;
    message_ready_count?: number;
    active_comment_blocked_count?: number;
  }
> {
  try {
    const rows = await listCachedInstagramCapabilities();
    const summary = summarizeInstagramCapabilities(rows);
    const status: CheckStatus =
      summary.activeCommentBlockedCount === 0 ? "ok" : "degraded";
    const detail =
      summary.activeCommentBlockedCount === 0
        ? `${summary.commentReadyCount}/${rows.length} accounts comment-ready; no active blocked comment campaign`
        : `${summary.activeCommentBlockedCount} account(s) have active COMMENT campaigns without verified comment capability`;
    return {
      status,
      detail,
      account_count: rows.length,
      comment_ready_count: summary.commentReadyCount,
      message_ready_count: summary.messageReadyCount,
      active_comment_blocked_count: summary.activeCommentBlockedCount,
    };
  } catch (error) {
    return {
      status: "error",
      detail:
        error instanceof Error
          ? error.message
          : "Instagram capability snapshot failed",
    };
  }
}

export async function GET() {
  const [database, redis, queue, worker, instagram_capabilities] =
    await Promise.all([
      checkDatabase(),
      checkRedis(),
      checkQueue(),
      getWorkerHealth().catch((error) => ({
        healthy: false,
        heartbeat: null,
        ageMs: null,
        error: error instanceof Error ? error.message : "Worker check failed",
      })),
      checkInstagramCapabilities(),
    ]);

  const healthy =
    database.status === "ok" &&
    redis.status === "ok" &&
    queue.status === "ok" &&
    worker.healthy &&
    instagram_capabilities.status === "ok";

  return NextResponse.json(
    {
      status: healthy ? "ok" : "degraded",
      checks: {
        database,
        redis,
        queue,
        worker,
        instagram_capabilities,
        // One-release compatibility projection for existing watchdogs and
        // dashboards. New consumers must use instagram_capabilities.
        instagram_scopes: instagram_capabilities,
      },
    },
    { status: healthy ? 200 : 503 },
  );
}
