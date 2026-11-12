import { NextRequest } from "next/server";
import { labError, labJson, requireLabReader } from "@/lib/copywriter/lab-http";
import { getRecentGenerations } from "@/lib/copywriter/lab";

// The feed changes with the queue; never cache.
export const dynamic = "force-dynamic";

/**
 * GET /api/copywriter/generations?limit=20 — the last production generations
 * (trials excluded), with the product facts, the AI output, the validated
 * `finalCopy`, and the campaign name joined from the generation's
 * automationId (which is guaranteed to live in this workspace — the save
 * path verifies it before storing).
 */
export async function GET(request: NextRequest) {
  try {
    const guard = await requireLabReader();
    if (!guard.ok) return guard.response;
    // Clamped here AND in the service: a huge limit must never pull the
    // workspace's whole generation history in one request.
    const limitParam = Number(request.nextUrl.searchParams.get("limit"));
    const limit = Number.isFinite(limitParam)
      ? Math.min(Math.max(Math.floor(limitParam), 1), 50)
      : 20;
    const generations = await getRecentGenerations(guard.context.workspaceId, limit);
    return labJson({ success: true, data: { generations } });
  } catch (error) {
    return labError(error);
  }
}
