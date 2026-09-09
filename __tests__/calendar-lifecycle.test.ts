import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { db } = vi.hoisted(() => ({ db: {
  $transaction: vi.fn(), $queryRaw: vi.fn(),
  workspace: { count: vi.fn() }, instagramAccount: { findFirst: vi.fn() },
  automation: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
  trackedLink: { update: vi.fn(), create: vi.fn() },
} }));
vi.mock("@/lib/db/client", () => ({ prisma: db }));
import { GET } from "@/app/api/cron/sync-calendar-intents/route";
import { calendarDeliveryCheckUrl, withAutomationDelivery } from "@/lib/automations/delivery-guard";

const intent = {
  publication_key: "calendar:event-1", calendar_event_id: "event-1", workspace_key: "yoyaku",
  account_owner: "yoyakurecordstore", publication_kind: "event", cta_keyword: "TICKETS",
  destination_url: "https://yoyaku.fr/events", scheduled_at: "2026-09-11T12:00:00.000Z",
  external_id: "media-1", status: "published", automation_status: "ready",
  source_revision: "revision-1", delivery_allowed: true, blocking_reasons: [],
};
function automation(overrides: Record<string, unknown> = {}) {
  return { id: "auto-1", source: "CALENDAR", sourceRevision: "revision-1",
    publicationKey: intent.publication_key, workspaceId: "ws_yoyaku_123", instagramAccountId: "ig-yoyaku",
    sourceWorkspaceKey: "yoyaku", sourceDeliveryAllowed: true, sourceBlockingReasons: [],
    isActive: true, lifecycle: "ACTIVE", postId: "media-1", keywords: ["TICKETS"],
    calendarScheduledAt: new Date(intent.scheduled_at), calendarStatus: "published", calendarAutomationStatus: "ready",
    trackedLinks: [{ id: "link-1", destinationUrl: intent.destination_url }], ...overrides };
}
let current: ReturnType<typeof automation> | null;
let fetchMock: ReturnType<typeof vi.fn>;
const snapshot = { id: "auto-1", source: "CALENDAR", sourceRevision: "revision-1" };
function sync() {
  return GET(new NextRequest("http://localhost/api/cron/sync-calendar-intents", { headers: { authorization: "Bearer test-cron" } }));
}
function feed(intents: unknown[] = [], retirements: unknown[] = [], complete = true) {
  fetchMock.mockResolvedValue(Response.json({ intents, retirements, snapshot_complete: complete }));
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CRON_SECRET", "test-cron");
  vi.stubEnv("CALENDAR_INTENT_SYNC_ENABLED", "true");
  vi.stubEnv("CALENDAR_INTENTS_URL", "https://admin.yoyaku.fr/api/internal/publications/automation-intents");
  vi.stubEnv("CALENDAR_INTENTS_SECRET", "test-internal");
  vi.stubEnv("CALENDAR_WORKSPACE_IDS", "yoyaku=ws_yoyaku_123,objects=ws_objects_456");
  current = automation();
  fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
  db.$transaction.mockImplementation((fn) => fn(db)); db.$queryRaw.mockResolvedValue([]);
  db.workspace.count.mockResolvedValue(2);
  db.instagramAccount.findFirst.mockImplementation(async ({ where }) => ({ id: where.workspaceId === "ws_yoyaku_123" ? "ig-yoyaku" : "ig-objects" }));
  db.automation.findUnique.mockImplementation(async () => current);
  db.automation.update.mockImplementation(async ({ data }) => { current = { ...current!, ...data }; return current; });
  db.automation.updateMany.mockImplementation(async ({ where, data }) => {
    if (!current || Object.entries(where).some(([key, value]) => key === "lifecycle"
      ? current!.lifecycle === (value as { not: string }).not
      : current![key as keyof typeof current] !== value)) return { count: 0 };
    current = { ...current, ...data }; return { count: 1 };
  });
  db.automation.create.mockImplementation(async ({ data }) => { current = automation(data); return current; });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("explicit Calendar lifecycle sync", () => {
  it("retires the last publication using a tombstone with no remaining intent", async () => {
    feed([], [{ publication_key: intent.publication_key, workspace_key: "yoyaku", source_revision: "retired-2", reason: "cancelled" }]);
    const res = await sync(); expect(res.status).toBe(200);
    expect(current).toMatchObject({ isActive: false, lifecycle: "PAUSED", sourceRevision: "retired-2" });
    expect((await res.json()).data.retired).toBe(1);
    expect(db.automation.create).not.toHaveBeenCalled();
  });
  it.each([true, false])("never infers retirements from an empty feed (complete=%s)", async (complete) => {
    feed([], [], complete); await sync(); expect(current?.isActive).toBe(true);
    expect(db.automation.updateMany).not.toHaveBeenCalled();
  });
  it("leaves existing rows untouched on feed failure or malformed payload", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline")); expect((await sync()).status).toBe(502);
    fetchMock.mockResolvedValueOnce(Response.json({})); expect((await sync()).status).toBe(502);
    expect(current?.isActive).toBe(true); expect(db.automation.update).not.toHaveBeenCalled();
  });
  it("pauses cancellation and never reactivates after the feed recovers", async () => {
    feed([{ ...intent, delivery_allowed: false, status: "cancelled", blocking_reasons: ["cancelled"] }]);
    await sync(); expect(current?.isActive).toBe(false); expect(current?.lifecycle).toBe("PAUSED");
    feed([intent]); await sync(); expect(current?.isActive).toBe(false); expect(current?.lifecycle).toBe("READY");
  });
  it.each([{ source_revision: "revision-2" }, { scheduled_at: "2026-09-12T12:00:00.000Z" }, { status: "rescheduled" }])(
    "requires human review for changed source %j", async (change) => {
      feed([{ ...intent, ...change }]); await sync(); expect(current?.isActive).toBe(false);
    }
  );
  it("retains a reviewed active campaign on an identical sync", async () => {
    feed([intent]); await sync(); expect(current?.isActive).toBe(true);
    expect(db.$queryRaw).toHaveBeenCalled();
  });
  it("creates blocked source intentions only as inactive paused drafts", async () => {
    current = null; feed([{ ...intent, delivery_allowed: false, blocking_reasons: ["tbc"] }]); await sync();
    expect(current).toMatchObject({ isActive: false, lifecycle: "PAUSED" });
  });
  it("never crosses workspaces for an intent or tombstone", async () => {
    feed([{ ...intent, workspace_key: "objects", account_owner: "objects.press", cta_keyword: "PRESSING", destination_url: "https://objects.press" }],
      [{ publication_key: intent.publication_key, workspace_key: "objects", source_revision: "wrong", reason: "cancelled" }]);
    const res = await sync(); expect(current?.isActive).toBe(true);
    expect((await res.json()).data).toMatchObject({ rejected: 1, retired: 0 });
  });
  it("keeps explicit retirement authoritative over a conflicting intent in the same snapshot", async () => {
    feed([intent], [{ publication_key: intent.publication_key, workspace_key: "yoyaku", source_revision: "retired", reason: "deleted" }]);
    await sync(); expect(current?.isActive).toBe(false); expect(db.automation.create).not.toHaveBeenCalled();
  });
});

describe("last-moment dispatch guard", () => {
  it("derives only the sibling canonical URL", () => {
    expect(calendarDeliveryCheckUrl()).toBe("https://admin.yoyaku.fr/api/internal/publications/delivery-check");
    expect(calendarDeliveryCheckUrl("http://events:3022/api/internal/publications/automation-intents")).toBe("http://events:3022/api/internal/publications/delivery-check");
    for (const url of ["ftp://host/api/internal/publications/automation-intents", "https://host/wrong", "https://host/api/internal/publications/automation-intents?next=evil", "https://u:p@host/api/internal/publications/automation-intents"]) {
      expect(() => calendarDeliveryCheckUrl(url)).toThrow();
    }
  });
  it("sends once only after row lock and exact allowed source check", async () => {
    fetchMock.mockResolvedValue(Response.json({ allowed: true, source_revision: "revision-1", blocking_reasons: [] }));
    const send = vi.fn(async () => "sent"); expect(await withAutomationDelivery(snapshot, send)).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
    expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0]);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST", cache: "no-store" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ publication_key: intent.publication_key, source_revision: "revision-1" });
  });
  it.each([
    { allowed: false, source_revision: "revision-1", blocking_reasons: ["cancelled"] },
    { allowed: true, source_revision: "revision-2", blocking_reasons: [] },
    { allowed: true, source_revision: "revision-1", blocking_reasons: ["tbc"] },
    {}, null,
  ])("blocks and suspends stale/blocked/malformed authority %j", async (source) => {
    fetchMock.mockResolvedValue(Response.json(source)); const send = vi.fn();
    await expect(withAutomationDelivery(snapshot, send)).rejects.toThrow("source_revision_or_policy_changed");
    expect(send).not.toHaveBeenCalled(); expect(current?.isActive).toBe(false);
  });
  it.each(["http", "timeout"])("fails closed on source %s error", async (kind) => {
    if (kind === "http") fetchMock.mockResolvedValue(new Response("unavailable", { status: 503 }));
    else fetchMock.mockRejectedValue(new DOMException("Timeout", "TimeoutError"));
    const send = vi.fn(); await expect(withAutomationDelivery(snapshot, send)).rejects.toThrow("source_unavailable");
    expect(send).not.toHaveBeenCalled();
  });
  it.each([{ isActive: false }, { sourceRevision: "newer" }, { workspaceId: "ws_objects_456" }, { sourceDeliveryAllowed: false }])(
    "blocks changed local state before calling either external service %j", async (change) => {
      current = automation(change); const send = vi.fn(); await expect(withAutomationDelivery(snapshot, send)).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    }
  );
  it("does not impose the Events dependency on manual campaigns, but still checks active", async () => {
    current = automation({ source: "MANUAL", sourceRevision: null }); const send = vi.fn(async () => "manual");
    expect(await withAutomationDelivery({ id: "auto-1", source: "MANUAL" }, send)).toBe("manual");
    expect(fetchMock).not.toHaveBeenCalled(); current.isActive = false;
    await expect(withAutomationDelivery({ id: "auto-1", source: "MANUAL" }, send)).rejects.toThrow("inactive");
    expect(send).toHaveBeenCalledTimes(1);
  });
});
