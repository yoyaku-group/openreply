import { NextRequest, NextResponse } from "next/server";
import {
  InstagramCapabilityBlockedError,
  listCachedInstagramCapabilities,
  probeAllInstagramCapabilities,
  probeInstagramAccountCapabilities,
  summarizeInstagramCapabilities,
} from "@/lib/meta/capabilities";
import {
  canManageCampaigns,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Authenticated, workspace-scoped Instagram capability diagnostics.
 * `probe=1` performs bounded read-only Meta calls; the default is DB-only.
 */
export async function GET(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }
  if (!canManageCampaigns(context.role)) {
    return NextResponse.json(
      {
        success: false,
        error:
          "Only editors, admins, and owners can read capability diagnostics",
      },
      { status: 403 },
    );
  }

  const focusAccount = request.nextUrl.searchParams.get("account");
  const wantProbe = request.nextUrl.searchParams.get("probe") === "1";

  try {
    if (focusAccount) {
      const account = await probeInstagramAccountCapabilities(focusAccount, {
        workspaceId: context.workspaceId,
        forceRefresh: wantProbe,
      });
      return NextResponse.json({ success: true, data: account });
    }
    if (wantProbe) {
      return NextResponse.json({
        success: true,
        data: await probeAllInstagramCapabilities(context.workspaceId),
      });
    }
    const accounts = await listCachedInstagramCapabilities(context.workspaceId);
    return NextResponse.json({
      success: true,
      data: summarizeInstagramCapabilities(accounts),
    });
  } catch (error) {
    if (
      error instanceof InstagramCapabilityBlockedError ||
      (error instanceof Error && error.message === "CROSS_TENANT_ACCESS")
    ) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 403 },
      );
    }
    throw error;
  }
}
