import { NextRequest, NextResponse } from "next/server";
import {
  listCachedAccountScopes,
  probeAccountScopes,
  probeAllAccountScopes,
} from "@/lib/meta/scope-check";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Authenticated admin endpoint for per-account Instagram scope detail.
 *
 * SECURITY: this is the ONLY route that returns per-account scope state.
 * `/api/health` deliberately exposes only a count summary so an unauthenticated
 * caller cannot learn which accounts hold which scopes — and so a load-
 * balancer probe stampede cannot burn Meta rate limits.
 *
 * Usage:
 *   GET  /api/admin/instagram-scopes             — cached snapshot, no Meta calls
 *   GET  /api/admin/instagram-scopes?probe=1     — live /debug_token for each account
 *   GET  /api/admin/instagram-scopes?account=<id>— focus on one account
 */
export async function GET(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }
  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can read scope detail" },
      { status: 403 }
    );
  }

  const wantProbe = request.nextUrl.searchParams.get("probe") === "1";
  const focusAccount = request.nextUrl.searchParams.get("account");

  if (focusAccount) {
    // Single-account live probe, even if `probe=0`. The admin explicitly
    // asked about one account — give them fresh data.
    const probe = await probeAccountScopes(focusAccount, { forceRefresh: true });
    return NextResponse.json({ success: true, data: probe });
  }

  if (wantProbe) {
    const result = await probeAllAccountScopes();
    return NextResponse.json({ success: true, data: result });
  }

  const cached = await listCachedAccountScopes();
  return NextResponse.json({ success: true, data: cached });
}
