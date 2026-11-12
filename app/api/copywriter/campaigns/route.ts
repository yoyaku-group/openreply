import { NextRequest } from "next/server";
import { labError, labJson, requireLabReader } from "@/lib/copywriter/lab-http";
import { searchCampaignsForExamples } from "@/lib/copywriter/lab";

// Search results move with the campaigns; never cache.
export const dynamic = "force-dynamic";

/**
 * GET /api/copywriter/campaigns?q=<name or SKU> — workspace campaigns that
 * can be picked as a golden example ("Make it an example" path when the
 * validated copy lives on a campaign rather than a generation). Read-only:
 * picking one goes through POST /api/copywriter/prompts { addExample }.
 */
export async function GET(request: NextRequest) {
  try {
    const guard = await requireLabReader();
    if (!guard.ok) return guard.response;
    const q = request.nextUrl.searchParams.get("q") ?? "";
    const campaigns = await searchCampaignsForExamples(guard.context.workspaceId, q);
    return labJson({ success: true, data: { campaigns } });
  } catch (error) {
    return labError(error);
  }
}
