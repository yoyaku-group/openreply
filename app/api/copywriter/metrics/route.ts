import { labError, labJson, requireLabReader } from "@/lib/copywriter/lab-http";
import { getLabMetrics } from "@/lib/copywriter/lab";

// Metrics move with every generation; never cache.
export const dynamic = "force-dynamic";

/**
 * GET /api/copywriter/metrics — per-version production metrics, one bounded
 * GROUP BY over the last 90 days. Trial rows are excluded. A version below
 * 5 generations reports enoughData=false ("not enough data" on the page).
 */
export async function GET() {
  try {
    const guard = await requireLabReader();
    if (!guard.ok) return guard.response;
    const metrics = await getLabMetrics(guard.context.workspaceId);
    return labJson({ success: true, data: { metrics } });
  } catch (error) {
    return labError(error);
  }
}
