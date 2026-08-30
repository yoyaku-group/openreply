import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getDMQueue, getRedisConnection } from "@/lib/queue/client";
import { getWorkerHealth } from "@/lib/ops/worker-health";
import { listCachedAccountScopes } from "@/lib/meta/scope-check";

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
      "failed"
    );
    return { status: "ok", counts };
  } catch (error) {
    return {
      status: "error",
      detail: error instanceof Error ? error.message : "Queue check failed",
    };
  }
}

const SCOPE_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Token-scope check, read-only from the local DB. NO Meta calls.
 *
 * SECURITY: this endpoint is unauthenticated (load-balancer probes), so it
 * MUST NOT trigger live Meta scope probes or expose per-account scope
 * detail — unauthenticated callers would otherwise burn Meta rate limits
 * by spamming the probe and learn which accounts hold which scopes. Per-
 * account detail lives at /api/admin/instagram-scopes (auth-gated).
 *
 * A `stale` flag tells operators when the cached scope data is too old to
 * be useful — usually that means a scheduled cron probe hasn't run, not
 * that scopes just drifted.
 */
async function checkInstagramScopes(): Promise<
  HealthCheck & {
    ok_count?: number;
    degraded_count?: number;
    stale?: boolean;
  }
> {
  try {
    // /api/health is unauthenticated — workspaceId is omitted to fetch
    // the cross-workspace roll-up used by the load-balancer probe.
    // Per-account scope detail is gated behind /api/admin/instagram-scopes.
    const rows = await listCachedAccountScopes();
    const okCount = rows.filter((r) => r.missing.length === 0).length;
    const degradedCount = rows.length - okCount;
    const now = Date.now();
    const oldest = rows
      .map((r) => r.lastProbeAt?.getTime() ?? 0)
      .reduce((a, b) => Math.max(a, b), 0);
    const stale =
      rows.length > 0 &&
      (oldest === 0 || now - oldest > SCOPE_STALE_THRESHOLD_MS);
    const status: CheckStatus =
      degradedCount === 0 && !stale ? "ok" : "degraded";
    const detail =
      degradedCount === 0 && !stale
        ? `${okCount}/${rows.length} accounts hold all required scopes`
        : degradedCount > 0
          ? `${degradedCount}/${rows.length} accounts missing one or more scopes — re-auth via Settings → Instagram`
          : `Scope data stale (oldest probe >${SCOPE_STALE_THRESHOLD_MS / 3600000}h ago) — run admin probe`;
    return {
      status,
      detail,
      ok_count: okCount,
      degraded_count: degradedCount,
      stale,
    };
  } catch (error) {
    return {
      status: "error",
      detail:
        error instanceof Error
          ? error.message
          : "Instagram scope snapshot failed",
    };
  }
}

export async function GET() {
  const [database, redis, queue, worker, instagram_scopes] = await Promise.all([
    checkDatabase(),
    checkRedis(),
    checkQueue(),
    getWorkerHealth().catch((error) => ({
      healthy: false,
      heartbeat: null,
      ageMs: null,
      error: error instanceof Error ? error.message : "Worker check failed",
    })),
    checkInstagramScopes(),
  ]);

  const healthy =
    database.status === "ok" &&
    redis.status === "ok" &&
    queue.status === "ok" &&
    worker.healthy;
  // instagram_scopes is intentionally excluded from `healthy`: a scope drift
  // affects comment/DM flows specifically, not the runtime. Operators read
  // checks.instagram_scopes directly and Discord alerting fires on degraded.

  return NextResponse.json(
    {
      status: healthy ? "ok" : "degraded",
      checks: {
        database,
        redis,
        queue,
        worker,
        instagram_scopes,
      },
    },
    { status: healthy ? 200 : 503 }
  );
}
