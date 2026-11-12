import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  getGenerationStatus,
  recordFinalCopy,
} from "@/lib/copywriter/service";
import { prisma } from "@/lib/db/client";
import {
  canManageCampaigns,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

// Read-your-writes for a generation the user is watching; never cache.
export const dynamic = "force-dynamic";

/**
 * Session-side copywriter status.
 *
 * GET: the assistant page polls this every 1.5 s while the host worker works.
 * PATCH: fired once after a successful save from the assistant, to record the
 * copy the team validated (`finalCopy`), its distance from what the model
 * wrote (`editDistance`) and the campaign it landed on (`automationId`).
 * Feeds lot S4.
 */

type RouteProps = { params: Promise<{ id: string }> };

const recordSchema = z.object({
  automationId: z.string().min(1).max(64),
  finalCopy: z.object({
    openingDm: z.string().max(2000).nullable(),
    openingButton: z.string().max(200).nullable(),
    revealDm: z.string().min(1).max(2000),
    linkButton: z.string().min(1).max(200),
  }),
});

export async function GET(request: NextRequest, { params }: RouteProps) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }
  const { id } = await params;
  const status = await getGenerationStatus(id, context.workspaceId);
  if (!status) {
    return NextResponse.json(
      { success: false, error: "Not found" },
      { status: 404 }
    );
  }
  return NextResponse.json(
    { success: true, data: status },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}

export async function PATCH(request: NextRequest, { params }: RouteProps) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }
  if (!canManageCampaigns(context.role)) {
    return NextResponse.json(
      {
        success: false,
        error: "Only editors, admins, and owners can record copy",
      },
      { status: 403 }
    );
  }

  const parsed = recordSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { id } = await params;
  // The recorded campaign must live in this workspace: a guessed id must not
  // stamp provenance onto someone else's campaign.
  const automation = await prisma.automation.findFirst({
    where: { id: parsed.data.automationId, workspaceId: context.workspaceId },
    select: { id: true },
  });
  if (!automation) {
    return NextResponse.json(
      { success: false, error: "Campaign not found in this workspace" },
      { status: 404 }
    );
  }

  const result = await recordFinalCopy(id, context.workspaceId, {
    automationId: automation.id,
    finalCopy: parsed.data.finalCopy,
  });
  if (!result) {
    return NextResponse.json(
      { success: false, error: "Not found" },
      { status: 404 }
    );
  }
  return NextResponse.json(
    { success: true, data: result },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}
