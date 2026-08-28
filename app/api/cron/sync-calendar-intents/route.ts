import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { generateReportShareSlug } from "@/lib/reports/share";
import { generateTrackedLinkSlug } from "@/lib/tracking/server";
import {
  calendarAutomationUpdateState,
  calendarCampaignName,
  normalizeCalendarIntent,
  parseCalendarWorkspaceIds,
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
    return NextResponse.json(
      { success: false, error: "Calendar intent sync is not fully configured" },
      { status: 500 }
    );
  }
  const configuredWorkspaceIds = [...workspaceIds.values()];
  const configuredWorkspaceCount = await prisma.workspace.count({
    where: { id: { in: configuredWorkspaceIds } },
  });
  if (configuredWorkspaceCount !== configuredWorkspaceIds.length) {
    return NextResponse.json(
      { success: false, error: "Calendar workspace mapping does not resolve" },
      { status: 500 }
    );
  }

  let payload: unknown;
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", "x-internal-secret": secret },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`intent source responded ${response.status}`);
    payload = await response.json();
  } catch (error) {
    console.error("[sync-calendar-intents] fetch failed", error);
    return NextResponse.json(
      { success: false, error: "Calendar intent source unreachable" },
      { status: 502 }
    );
  }

  const rawIntents = Array.isArray((payload as { intents?: unknown[] })?.intents)
    ? (payload as { intents: unknown[] }).intents.slice(0, 1000)
    : [];
  let created = 0;
  let updated = 0;
  let rejected = 0;
  let errors = 0;

  for (const raw of rawIntents) {
    const intent = normalizeCalendarIntent(raw);
    if (!intent) { rejected += 1; continue; }
    const workspaceId = workspaceIds.get(intent.workspace_key);
    if (!workspaceId) { rejected += 1; continue; }
    try {
      const account = await prisma.instagramAccount.findFirst({
        where: { workspaceId, username: intent.account_owner, archivedAt: null },
        select: { id: true },
      });
      if (!account) { rejected += 1; continue; }

      const existing = await prisma.automation.findUnique({
        where: { publicationKey: intent.publication_key },
        select: {
          id: true,
          source: true,
          lifecycle: true,
          isActive: true,
          postId: true,
          workspaceId: true,
          instagramAccountId: true,
          keywords: true,
          trackedLinks: {
            orderBy: { createdAt: "asc" },
            take: 1,
            select: { id: true, destinationUrl: true },
          },
        },
      });
      const postId = intent.external_id || null;
      if (existing) {
        if (
          existing.source !== "CALENDAR" ||
          existing.lifecycle === "ARCHIVED" ||
          existing.workspaceId !== workspaceId ||
          existing.instagramAccountId !== account.id
        ) {
          rejected += 1;
          continue;
        }
        const trackedLink = existing.trackedLinks[0] ?? null;
        const state = calendarAutomationUpdateState({
          isActive: existing.isActive,
          postId: existing.postId,
          keywords: existing.keywords,
          destinationUrl: trackedLink?.destinationUrl ?? null,
        }, intent);
        await prisma.$transaction(async (tx) => {
          await tx.automation.update({
            where: { id: existing.id },
            data: {
              name: calendarCampaignName(intent),
              postId,
              postUrl: intent.published_url || null,
              pendingNextReel: false,
              catnoTag: intent.release_skus[0] || null,
              keywords: [intent.cta_keyword],
              isActive: state.isActive,
              lifecycle: state.lifecycle,
              calendarEventId: intent.calendar_event_id,
              calendarScheduledAt: intent.scheduled_at ? new Date(intent.scheduled_at) : null,
              sourceWorkspaceKey: intent.workspace_key,
            },
          });
          if (trackedLink) {
            await tx.trackedLink.update({
              where: { id: trackedLink.id },
              data: { destinationUrl: intent.destination_url },
            });
          } else {
            await tx.trackedLink.create({
              data: {
                workspaceId,
                automationId: existing.id,
                slug: generateTrackedLinkSlug(),
                label: "Primary campaign link",
                destinationUrl: intent.destination_url,
              },
            });
          }
        });
        updated += 1;
        continue;
      }

      await prisma.automation.create({
        data: {
          workspaceId,
          instagramAccountId: account.id,
          name: calendarCampaignName(intent),
          goal: "Calendar comment-to-DM draft",
          triggerType: "COMMENT",
          postId,
          postUrl: intent.published_url || null,
          pendingNextReel: false,
          catnoTag: intent.release_skus[0] || null,
          matchAnyPost: false,
          keywords: [intent.cta_keyword],
          matchAnyWord: false,
          dmMessage: "Here you go:",
          openingDmEnabled: true,
          openingDmMessage: "Here is the link you asked for.",
          openingDmButtonLabel: "Get the link",
          linkButtonLabel: "Open link",
          isActive: false,
          wholeWordMatch: true,
          source: "CALENDAR",
          lifecycle: postId ? "READY" : "PLANNED",
          publicationKey: intent.publication_key,
          calendarEventId: intent.calendar_event_id,
          calendarScheduledAt: intent.scheduled_at ? new Date(intent.scheduled_at) : null,
          sourceWorkspaceKey: intent.workspace_key,
          reportShareSlug: generateReportShareSlug(),
          trackedLinks: {
            create: {
              workspaceId,
              slug: generateTrackedLinkSlug(),
              label: "Primary campaign link",
              destinationUrl: intent.destination_url,
            },
          },
        },
      });
      created += 1;
    } catch (error) {
      errors += 1;
      console.error("[sync-calendar-intents] intent failed", {
        publicationKey: intent.publication_key,
        error,
      });
    }
  }

  return NextResponse.json(
    {
      success: errors === 0,
      data: { enabled: true, fetched: rawIntents.length, created, updated, rejected, errors },
    },
    { status: errors === 0 ? 200 : 502 }
  );
}
