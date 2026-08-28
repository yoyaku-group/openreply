import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

export async function POST(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can disconnect accounts" },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const instagramAccountId =
    typeof body.instagramAccountId === "string" ? body.instagramAccountId : null;

  // Guard (incident 2026-08-27): without this, an empty-body POST deleted
  // EVERY account of the workspace — cascading to automations, DM logs and
  // tracked links. The UI always sends the id; only raw calls ever hit the
  // unfiltered branch. One account per call, never a workspace wipe.
  if (!instagramAccountId) {
    return NextResponse.json(
      {
        success: false,
        error:
          "instagramAccountId is required — disconnect one account at a time",
      },
      { status: 400 }
    );
  }

  await prisma.instagramAccount.deleteMany({
    where: {
      workspaceId: context.workspaceId,
      id: instagramAccountId,
    },
  });

  return NextResponse.json({ success: true });
}
