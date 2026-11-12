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
    const limitParam = Number(request.nextUrl.searchParams.get("limit"));
    const generations = await getRecentGenerations(
      guard.context.workspaceId,
      Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 20
    );
    return labJson({ success: true, data: { generations } });
  } catch (error) {
    return labError(error);
  }
}
