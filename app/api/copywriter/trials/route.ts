import { NextRequest } from "next/server";
import { z } from "zod";
import { CopywriterError } from "@/lib/copywriter/service";
import { labError, labJson, authorEmailFor, requireLabReader, requireLabWriter } from "@/lib/copywriter/lab-http";
import { createTrialRun, getTrialResults, trialVerdict } from "@/lib/copywriter/lab";

// Trial results are polled while the worker runs; never cache.
export const dynamic = "force-dynamic";

/**
 * POST /api/copywriter/trials { body, model } — enqueue one isolated trial
 * run: at most 5 generations, one per recent distinct input, marked isTrial,
 * never carrying an automationId, never auto-applied, excluded from
 * production metrics. A second concurrent run per workspace is refused
 * (TRIAL_IN_PROGRESS): every generation spends the shared quota.
 * GET /api/copywriter/trials?ids=… — the polled results, each paired with
 * the active version's output for the same input, plus the gate verdict.
 */

const trialSchema = z.object({
  body: z.string().min(1).max(4000),
  model: z.enum(["haiku", "sonnet"]),
});

function idsFrom(request: NextRequest): string[] {
  const raw = request.nextUrl.searchParams.get("ids") ?? "";
  return raw.split(",").map((id) => id.trim()).filter(Boolean).slice(0, 5);
}

export async function POST(request: NextRequest) {
  try {
    const guard = await requireLabWriter();
    if (!guard.ok) return guard.response;
    const parsed = trialSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return labJson({ success: false, error: "INVALID_BODY" }, 400);
    }
    const run = await createTrialRun({
      workspaceId: guard.context.workspaceId,
      body: parsed.data.body,
      model: parsed.data.model,
      authorEmail: await authorEmailFor(guard.context.userId),
    });
    return labJson({ success: true, data: run });
  } catch (error) {
    return labError(error);
  }
}

export async function GET(request: NextRequest) {
  try {
    const guard = await requireLabReader();
    if (!guard.ok) return guard.response;
    const ids = idsFrom(request);
    if (ids.length === 0) {
      return labJson({ success: false, error: "INVALID_TRIAL_IDS" }, 400);
    }
    const [results, verdict] = await Promise.all([
      getTrialResults(guard.context.workspaceId, ids),
      trialVerdict(guard.context.workspaceId, ids).catch((error) => {
        if (error instanceof CopywriterError && error.code === "NOT_FOUND") return null;
        throw error;
      }),
    ]);
    return labJson({ success: true, data: { results, verdict } });
  } catch (error) {
    return labError(error);
  }
}
