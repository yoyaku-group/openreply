import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { labError, labJson, authorEmailFor, requireLabWriter } from "@/lib/copywriter/lab-http";
import { getPromptVersions, revertToPrompt } from "@/lib/copywriter/lab";

// Read-your-writes; never cache.
export const dynamic = "force-dynamic";

/**
 * POST /api/copywriter/prompts/[id]/revert — one-click rollback. Creates a
 * NEW version (max + 1) copying the target's body, model and examples and
 * flips it active in one transaction; the target row is never rewritten.
 * The reason is required.
 */

type RouteProps = { params: Promise<{ id: string }> };

const revertSchema = z.object({
  reason: z.string().min(1).max(500),
});

export async function POST(request: NextRequest, { params }: RouteProps) {
  try {
    const guard = await requireLabWriter();
    if (!guard.ok) return guard.response;
    const parsed = revertSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: "REASON_REQUIRED", details: parsed.error.flatten() },
        { status: 400 }
      );
    }
    const { id } = await params;
    await revertToPrompt({
      workspaceId: guard.context.workspaceId,
      promptId: id,
      reason: parsed.data.reason,
      authorEmail: await authorEmailFor(guard.context.userId),
    });
    const { versions, active } = await getPromptVersions(guard.context.workspaceId);
    return labJson({ success: true, data: { versions, active } });
  } catch (error) {
    return labError(error);
  }
}
