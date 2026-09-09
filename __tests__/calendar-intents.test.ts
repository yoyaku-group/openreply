import { describe, expect, it } from "vitest";
import {
  calendarAutomationUpdateState,
  calendarCampaignName,
  normalizeCalendarIntent,
  parseCalendarWorkspaceIds,
} from "@/lib/automations/calendar-intents";

const base = {
  source_revision: "revision-1",
  delivery_allowed: true,
  blocking_reasons: [],
  publication_key: "calendar:event-1",
  calendar_event_id: "event-1",
  workspace_key: "yoyaku",
  account_owner: "yoyakurecordstore",
  publication_kind: "release",
  subject_key: "mb059",
  release_skus: ["mb059"],
  scheduled_at: "2026-08-30T10:00:00.000Z",
  cta_keyword: "link",
  caption_draft: "#MB059 Out now",
  destination_url: "https://yoyaku.io/release/mb059/",
  assets_url: null,
  published_url: null,
  external_id: null,
  status: "scheduled",
  automation_status: "ready",
  updated_at: "2026-08-28T10:00:00.000Z",
};

describe("calendar intent contract", () => {
  it("normalizes an exact YOYAKU intent", () => {
    const intent = normalizeCalendarIntent(base);
    expect(intent).not.toBeNull();
    expect(intent?.release_skus).toEqual(["MB059"]);
    expect(intent?.cta_keyword).toBe("LINK");
    expect(intent && calendarCampaignName(intent)).toBe("MB059 LINK · Calendar");
  });

  it("fails closed on cross-tenant sender or CTA vocabulary", () => {
    expect(
      normalizeCalendarIntent({ ...base, workspace_key: "objects", account_owner: "yoyakurecordstore" })
    ).toBeNull();
    expect(
      normalizeCalendarIntent({ ...base, workspace_key: "objects", account_owner: "objects.press", cta_keyword: "LINK" })
    ).toBeNull();
    expect(normalizeCalendarIntent({ ...base, destination_url: "http://unsafe.test" })).toBeNull();
    expect(normalizeCalendarIntent({ ...base, destination_url: "https://phishing.test/release" })).toBeNull();
    expect(normalizeCalendarIntent({ ...base, destination_url: "https://shotgun.live/events/test" })).not.toBeNull();
    expect(normalizeCalendarIntent({
      ...base,
      workspace_key: "objects",
      account_owner: "objects.press",
      cta_keyword: "PRESSING",
      destination_url: "https://configurator.objects.press/start",
    })).not.toBeNull();
  });

  it("requires stable mappings for both named tenants", () => {
    expect(
      parseCalendarWorkspaceIds("yoyaku=ws_yoyaku_123,objects=ws_objects_456,broken,foo=bar")
    ).toEqual(new Map([["yoyaku", "ws_yoyaku_123"], ["objects", "ws_objects_456"]]));
    expect(parseCalendarWorkspaceIds("yoyaku=CHANGE_ME,objects=short")).toEqual(new Map());
  });

  it("deactivates a live campaign when a material intent changes", () => {
    const intent = normalizeCalendarIntent(base)!;
    expect(calendarAutomationUpdateState({
      sourceRevision: base.source_revision,
      calendarScheduledAt: new Date(base.scheduled_at),
      calendarStatus: base.status,
      calendarAutomationStatus: base.automation_status,
      isActive: true,
      postId: null,
      keywords: ["LINK"],
      destinationUrl: base.destination_url,
    }, intent)).toEqual({ isActive: false, lifecycle: "PLANNED", materialChanged: true });

    expect(calendarAutomationUpdateState({
      sourceRevision: base.source_revision,
      calendarScheduledAt: new Date(base.scheduled_at),
      calendarStatus: base.status,
      calendarAutomationStatus: base.automation_status,
      isActive: true,
      postId: null,
      keywords: ["LINK"],
      destinationUrl: "https://yoyaku.io/release/old/",
    }, intent)).toEqual({ isActive: false, lifecycle: "PLANNED", materialChanged: true });

    const published = normalizeCalendarIntent({
      ...base,
      external_id: "media-123",
      published_url: "https://www.instagram.com/p/example/",
    })!;
    expect(calendarAutomationUpdateState({
      sourceRevision: base.source_revision,
      calendarScheduledAt: new Date(base.scheduled_at),
      calendarStatus: base.status,
      calendarAutomationStatus: base.automation_status,
      isActive: true,
      postId: "media-123",
      keywords: ["LINK"],
      destinationUrl: base.destination_url,
    }, published)).toEqual({ isActive: true, lifecycle: "ACTIVE", materialChanged: false });
    expect(calendarAutomationUpdateState({
      sourceRevision: base.source_revision,
      calendarScheduledAt: new Date(base.scheduled_at),
      calendarStatus: base.status,
      calendarAutomationStatus: base.automation_status,
      isActive: true,
      postId: "media-old",
      keywords: ["LINK"],
      destinationUrl: base.destination_url,
    }, published)).toEqual({ isActive: false, lifecycle: "READY", materialChanged: true });
  });
});

// Lifecycle regression: a cancellation used to keep a bound active campaign live.
it("suspends an unchanged media binding when the source cancels delivery", () => {
  const intent = normalizeCalendarIntent({ ...base, external_id: "media-123",
    status: "cancelled", delivery_allowed: false, blocking_reasons: ["cancelled"] })!;
  expect(calendarAutomationUpdateState({ isActive: true, postId: "media-123",
    keywords: ["LINK"], destinationUrl: base.destination_url }, intent).isActive).toBe(false);
});

it.each([
  { source_revision: "revision-2" },
  { scheduled_at: "2026-10-01T10:00:00.000Z" },
  { status: "cancelled" },
  { automation_status: "blocked" },
])("requires human review after material source changes %j", (change) => {
  const intent = normalizeCalendarIntent({ ...base, external_id: "media-123", ...change })!;
  const existing = { isActive: true, postId: "media-123", keywords: ["LINK"],
    destinationUrl: base.destination_url, sourceRevision: base.source_revision,
    calendarScheduledAt: new Date(base.scheduled_at), calendarStatus: base.status,
    calendarAutomationStatus: base.automation_status };
  expect(calendarAutomationUpdateState(existing, intent).isActive).toBe(false);
  expect(calendarAutomationUpdateState({ ...existing, isActive: false }, intent).isActive).toBe(false);
});
