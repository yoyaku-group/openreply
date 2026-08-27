import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getDMQueue, getRedisConnection } from "@/lib/queue/client";
import { getWorkerHealth } from "@/lib/ops/worker-health";
import { probeAllAccountScopes } from "@/lib/meta/scope-check";

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

/**
 * Token-scope probe for every live Instagram account. Returns "ok" only
 * when every account holds the three required scopes; "degraded" flags
 * missing scopes or transient probe failures. The /api/health wrapper does
 * NOT propagate this status to the overall `healthy` flag — a scope drift
 * on one account should not take down the rest of the API. Operators read
 * the `checks.instagram_scopes` field directly or fire a Discord alert via
 * the rules/40 circuit breaker when degraded_count > 0.
 */
async function checkInstagramScopes(): Promise<
  HealthCheck & {
    ok_count?: number;
    degraded_count?: number;
    accounts?: unknown;
  }
> {
  try {
    const { accounts, okCount, degradedCount } = await probeAllAccountScopes();
    const status: CheckStatus = degradedCount === 0 ? "ok" : "degraded";
    const detail =
      degradedCount === 0
        ? `${okCount}/${accounts.length} accounts hold all required scopes`
        : `${degradedCount}/${accounts.length} accounts missing one or more scopes — re-auth via Settings → Instagram`;
    return {
      status,
      detail,
      ok_count: okCount,
      degraded_count: degradedCount,
      accounts: accounts.map((a) => ({
        id: a.accountId,
        username: a.username,
        ok: a.ok && a.missing.length === 0,
        granted: a.grantedScopes,
        missing: a.missing,
        lastProbeAt: a.lastProbeAt,
        error: a.error,
      })),
    };
  } catch (error) {
    return {
      status: "error",
      detail:
        error instanceof Error
          ? error.message
          : "Instagram scope probe failed",
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
