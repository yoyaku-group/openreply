import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { parseCalendarWorkspaceIds } from "@/lib/automations/calendar-intents";

/** Read-only campaign evidence for an exact release publication and tenant. */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET || "";
  const actual = Buffer.from(request.headers.get("authorization") || "");
  const expected = Buffer.from(`Bearer ${secret}`);
  const respond = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "cache-control": "private, no-store" } });
  if (secret.length < 32 || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return respond({ success: false, error: "Unauthorized" }, 401);
  }
  const query = request.nextUrl.searchParams;
  const sku = (query.get("sku") || "").trim().toUpperCase();
  if (!/^[A-Z0-9_-]{1,80}$/.test(sku)) return respond({ success: false, error: "invalid_sku" }, 400);
  const workspace = query.get("workspace_key");
  const account = (query.get("account_owner") || "").trim().toLowerCase();
  const publication = query.get("publication_key");
  const post = query.get("post_id");
  const automationId = query.get("automation_id");
  if (!workspace || !account || !(publication || post || automationId)) {
    // Older SKU-only callers may keep rendering their page, but must never
    // decorate another release phase with the newest campaign's measurements.
    return respond({ success: true, data: { automation: null, resolution: "scope_required" } });
  }
  const workspaceId = (workspace === "yoyaku" || workspace === "objects") ? parseCalendarWorkspaceIds().get(workspace) : null;
  if (!workspaceId || account !== (workspace === "objects" ? "objects.press" : "yoyakurecordstore")) {
    return respond({ success: false, error: "invalid_campaign_scope" }, 400);
  }
  if ([publication, post, automationId].some(value => value !== null && (!value.trim() || value.length > 256))) {
    return respond({ success: false, error: "invalid_publication_identity" }, 400);
  }
  const scope = { workspace_key: workspace, account_owner: account, publication_key: publication, post_id: post, automation_id: automationId };
  const matches = await prisma.automation.findMany({
    where: { workspaceId, instagramAccount: { username: { equals: account, mode: "insensitive" } },
      catnoTag: { equals: sku, mode: "insensitive" },
      ...(publication ? { publicationKey: publication } : {}), ...(post ? { postId: post } : {}),
      ...(automationId ? { id: automationId } : {}), lifecycle: { not: "ARCHIVED" } },
    take: 2,
    select: { id: true, name: true, triggerType: true, keywords: true, isActive: true, postId: true,
      publicationKey: true, createdAt: true },
  });
  if (matches.length !== 1) return respond({ success: true, data: { automation: null, scope,
    resolution: matches.length ? "ambiguous" : "not_found" } });
  const automation = matches[0];
  const [dmSent, clicks] = await Promise.all([
    prisma.dmLog.count({ where: { automationId: automation.id, workspaceId, status: "SENT" } }),
    prisma.linkClick.count({ where: { automationId: automation.id, workspaceId } }),
  ]);
  return respond({ success: true, data: { automation: { ...automation, dmSent, clicks }, scope, resolution: "exact" } });
}
