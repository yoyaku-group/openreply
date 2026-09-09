import { prisma } from "@/lib/db/client";
import { parseCalendarWorkspaceIds } from "./calendar-intents";

export class AutomationDeliveryBlocked extends Error {
  constructor(public reason: string) {
    super(`Automation delivery blocked: ${reason}`);
    this.name = "AutomationDeliveryBlocked";
  }
}

export type DeliverySnapshot = {
  id: string;
  source?: string;
  sourceRevision?: string | null;
};

/** Only the configured canonical endpoint can define the guard destination. */
export function calendarDeliveryCheckUrl(raw = process.env.CALENDAR_INTENTS_URL): string {
  if (!raw) throw new AutomationDeliveryBlocked("source_not_configured");
  const url = new URL(raw);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      !url.pathname.endsWith("/api/internal/publications/automation-intents")) {
    throw new AutomationDeliveryBlocked("invalid_source_url");
  }
  url.pathname = url.pathname.replace(/automation-intents$/, "delivery-check");
  return url.toString();
}

/**
 * The row lock orders dispatch with sync, tombstones and staff pause updates.
 * Hold it until the bounded Meta request settles. A send already dispatched
 * before a source cancellation cannot be recalled across the two services.
 */
export async function withAutomationDelivery<T>(
  snapshot: DeliverySnapshot,
  send: () => Promise<T>
): Promise<T> {
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Automation" WHERE "id" = ${snapshot.id} FOR UPDATE`;
    const current = await tx.automation.findUnique({ where: { id: snapshot.id } });
    if (!current?.isActive || current.lifecycle === "ARCHIVED") {
      return { blocked: "inactive" } as const;
    }
    if (current.source === "CALENDAR") {
      if (snapshot.source !== "CALENDAR" || !snapshot.sourceRevision ||
          snapshot.sourceRevision !== current.sourceRevision) {
        return { blocked: "stale_job_revision" } as const;
      }
      const mappedWorkspace = parseCalendarWorkspaceIds().get(
        current.sourceWorkspaceKey as "yoyaku" | "objects"
      );
      if (mappedWorkspace !== current.workspaceId || !current.publicationKey ||
          !current.sourceDeliveryAllowed || current.sourceBlockingReasons.length) {
        return { blocked: "source_blocked" } as const;
      }
      let source: { allowed?: unknown; source_revision?: unknown; blocking_reasons?: unknown };
      try {
        const secret = process.env.CALENDAR_INTENTS_SECRET;
        if (!secret) return { blocked: "source_not_configured" } as const;
        const response = await fetch(calendarDeliveryCheckUrl(), {
          method: "POST",
          headers: { "content-type": "application/json", "x-internal-secret": secret },
          body: JSON.stringify({ publication_key: current.publicationKey, source_revision: current.sourceRevision }),
          signal: AbortSignal.timeout(5_000),
          cache: "no-store", redirect: "error",
        });
        if (!response.ok) return { blocked: "source_unavailable" } as const;
        source = await response.json();
      } catch {
        return { blocked: "source_unavailable" } as const;
      }
      if (source?.allowed !== true || source.source_revision !== current.sourceRevision ||
          !Array.isArray(source.blocking_reasons) || source.blocking_reasons.length) {
        // Commit the suspension, then report refusal outside the transaction.
        await tx.automation.update({ where: { id: current.id }, data: {
          isActive: false, lifecycle: "PAUSED", sourceDeliveryAllowed: false,
          sourceBlockingReasons: [source?.source_revision !== current.sourceRevision ? "stale_source_revision" : "delivery_check_blocked"],
        } });
        return { blocked: "source_revision_or_policy_changed" } as const;
      }
    } else if (snapshot.source === "CALENDAR") {
      return { blocked: "source_changed" } as const;
    }
    return { value: await send() } as const;
  }, { maxWait: 5_000, timeout: 30_000 });
  if ("blocked" in outcome) throw new AutomationDeliveryBlocked(outcome.blocked!);
  return outcome.value;
}
