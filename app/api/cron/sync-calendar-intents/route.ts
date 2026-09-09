import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { generateReportShareSlug } from "@/lib/reports/share";
import { generateTrackedLinkSlug } from "@/lib/tracking/server";
import {
  calendarAutomationUpdateState, calendarCampaignName, calendarRetirementSchema,
  normalizeCalendarIntent, parseCalendarWorkspaceIds,
} from "@/lib/automations/calendar-intents";

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET || process.env.NEXTAUTH_SECRET;
  if (!cronSecret || request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (process.env.CALENDAR_INTENT_SYNC_ENABLED !== "true") {
    return NextResponse.json({ success: true, data: { enabled: false, created: 0, updated: 0 } });
  }
  const url = process.env.CALENDAR_INTENTS_URL;
  const secret = process.env.CALENDAR_INTENTS_SECRET;
  const workspaceIds = parseCalendarWorkspaceIds();
  if (!url || !secret || !workspaceIds.has("yoyaku") || !workspaceIds.has("objects")) {
    return NextResponse.json({ success: false, error: "Calendar intent sync is not fully configured" }, { status: 500 });
  }
  const configuredWorkspaceIds = [...workspaceIds.values()];
  if (await prisma.workspace.count({ where: { id: { in: configuredWorkspaceIds } } }) !== configuredWorkspaceIds.length) {
    return NextResponse.json({ success: false, error: "Calendar workspace mapping does not resolve" }, { status: 500 });
  }

  let payload: { intents: unknown[]; retirements: unknown[]; snapshot_complete?: boolean };
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", "x-internal-secret": secret },
      signal: AbortSignal.timeout(20_000), cache: "no-store", redirect: "error",
    });
    if (!response.ok) throw new Error(`intent source responded ${response.status}`);
    payload = await response.json();
    if (!Array.isArray(payload?.intents) || !Array.isArray(payload?.retirements) ||
        payload.intents.length > 1000 || payload.retirements.length > 1000) {
      throw new Error("invalid lifecycle feed");
    }
  } catch (error) {
    console.error("[sync-calendar-intents] fetch failed", error);
    return NextResponse.json({ success: false, error: "Calendar intent source unreachable or invalid" }, { status: 502 });
  }

  let created = 0, updated = 0, retired = 0, rejected = 0, errors = 0;
  // Never infer retirement from absence, pagination, snapshot_complete or an empty feed.
  const retirements = payload.retirements.flatMap((raw) => {
    const parsed = calendarRetirementSchema.safeParse(raw);
    if (!parsed.success) { rejected += 1; return []; }
    return [parsed.data];
  });
  const retiredKeys = new Set(retirements.map((r) => `${r.workspace_key}:${r.publication_key}`));
  for (const raw of payload.intents) {
    const intent = normalizeCalendarIntent(raw);
    if (!intent) { rejected += 1; continue; }
    if (retiredKeys.has(`${intent.workspace_key}:${intent.publication_key}`)) { rejected += 1; continue; }
    const workspaceId = workspaceIds.get(intent.workspace_key);
    if (!workspaceId) { rejected += 1; continue; }
    try {
      const account = await prisma.instagramAccount.findFirst({
        where: { workspaceId, username: intent.account_owner, archivedAt: null }, select: { id: true },
      });
      if (!account) { rejected += 1; continue; }
      const result = await prisma.$transaction(async (tx) => {
        // Serialize with staff pauses and each Meta dispatch; read state AFTER lock.
        await tx.$queryRaw`SELECT "id" FROM "Automation" WHERE "publicationKey" = ${intent.publication_key} FOR UPDATE`;
        const existing = await tx.automation.findUnique({
          where: { publicationKey: intent.publication_key },
          include: { trackedLinks: { orderBy: { createdAt: "asc" }, take: 1 } },
        });
        const postId = intent.external_id || null;
        const provenance = {
          calendarEventId: intent.calendar_event_id,
          calendarScheduledAt: intent.scheduled_at ? new Date(intent.scheduled_at) : null,
          sourceWorkspaceKey: intent.workspace_key,
          sourceRevision: intent.source_revision,
          sourceDeliveryAllowed: intent.delivery_allowed,
          sourceBlockingReasons: intent.blocking_reasons,
          calendarStatus: intent.status,
          calendarAutomationStatus: intent.automation_status,
        };
        const content = {
          name: calendarCampaignName(intent), postId, postUrl: intent.published_url || null,
          pendingNextReel: false, catnoTag: intent.release_skus[0] || null,
          keywords: [intent.cta_keyword], ...provenance,
        };
        if (existing) {
          if (existing.source !== "CALENDAR" || existing.lifecycle === "ARCHIVED" ||
              existing.workspaceId !== workspaceId || existing.instagramAccountId !== account.id) return "rejected";
          const trackedLink = existing.trackedLinks[0] ?? null;
          const state = calendarAutomationUpdateState({ ...existing, destinationUrl: trackedLink?.destinationUrl ?? null }, intent);
          await tx.automation.update({ where: { id: existing.id }, data: {
            ...content, isActive: state.isActive, lifecycle: state.lifecycle,
          } });
          if (trackedLink) {
            await tx.trackedLink.update({ where: { id: trackedLink.id }, data: { destinationUrl: intent.destination_url } });
          } else {
            await tx.trackedLink.create({ data: {
              workspaceId, automationId: existing.id, slug: generateTrackedLinkSlug(),
              label: "Primary campaign link", destinationUrl: intent.destination_url,
            } });
          }
          return "updated";
        }
        await tx.automation.create({ data: {
          ...content, workspaceId, instagramAccountId: account.id,
          goal: "Calendar comment-to-DM draft", triggerType: "COMMENT",
          matchAnyPost: false, matchAnyWord: false, dmMessage: "Here you go:",
          openingDmEnabled: true, openingDmMessage: "Here is the link you asked for.",
          openingDmButtonLabel: "Get the link", linkButtonLabel: "Open link",
          isActive: false, wholeWordMatch: true, source: "CALENDAR",
          lifecycle: !intent.delivery_allowed || intent.blocking_reasons.length ? "PAUSED" : postId ? "READY" : "PLANNED",
          publicationKey: intent.publication_key, reportShareSlug: generateReportShareSlug(),
          trackedLinks: { create: {
            workspaceId, slug: generateTrackedLinkSlug(), label: "Primary campaign link", destinationUrl: intent.destination_url,
          } },
        } });
        return "created";
      }, { maxWait: 5_000, timeout: 30_000 });
      if (result === "created") created += 1;
      else if (result === "updated") updated += 1;
      else rejected += 1;
    } catch (error) {
      errors += 1;
      console.error("[sync-calendar-intents] intent failed", { publicationKey: intent.publication_key, error });
    }
  }
  for (const retirement of retirements) {
    const workspaceId = workspaceIds.get(retirement.workspace_key);
    if (!workspaceId) { rejected += 1; continue; }
    try {
      // UPDATE acquires the same row lock as dispatch. Tombstones never cross tenants.
      const result = await prisma.automation.updateMany({ where: {
        publicationKey: retirement.publication_key, workspaceId,
        sourceWorkspaceKey: retirement.workspace_key, source: "CALENDAR",
        lifecycle: { not: "ARCHIVED" },
      }, data: {
        isActive: false, lifecycle: "PAUSED", sourceRevision: retirement.source_revision,
        sourceDeliveryAllowed: false, sourceBlockingReasons: [retirement.reason],
      } });
      retired += result.count;
    } catch (error) {
      errors += 1;
      console.error("[sync-calendar-intents] retirement failed", { publicationKey: retirement.publication_key, error });
    }
  }
  return NextResponse.json({ success: errors === 0, data: {
    enabled: true, fetched: payload.intents.length, created, updated, retired, rejected, errors,
    snapshotComplete: payload.snapshot_complete === true,
  } }, { status: errors === 0 ? 200 : 502 });
}
