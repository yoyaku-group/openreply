import { describe, expect, it, vi } from "vitest";
import {
  evaluateInstagramFeature,
  type CachedCapability,
} from "../lib/meta/capabilities";
import type { InstagramCapabilityKind } from "../app/generated/prisma/client";

function capability(
  kind: InstagramCapabilityKind,
  status: CachedCapability["status"],
  reason = "TEST",
): CachedCapability {
  return {
    kind,
    status,
    reason,
    evidence: null,
    checkedAt: new Date(),
    lastSuccessAt: status === "READY" ? new Date() : null,
  };
}

function registry(
  overrides: Partial<Record<InstagramCapabilityKind, CachedCapability>> = {},
) {
  return {
    BASIC: capability("BASIC", "READY"),
    COMMENTS: capability("COMMENTS", "READY"),
    MESSAGES: capability("MESSAGES", "READY"),
    INSIGHTS: capability("INSIGHTS", "READY"),
    CONTENT_PUBLISH: capability("CONTENT_PUBLISH", "UNKNOWN"),
    ...overrides,
  };
}

describe("evaluateInstagramFeature", () => {
  it("requires both a ready comments capability and a verified comments subscription", () => {
    expect(
      evaluateInstagramFeature(
        "COMMENTS",
        registry(),
        ["comments", "messages"],
        new Date(),
        ["comments", "messages"],
      ),
    ).toEqual({ ready: true, blockers: [] });
  });

  it("does not gate a comment-to-DM campaign on the Conversations API", () => {
    // A private reply (POST /{ig}/messages with recipient={comment_id}) needs
    // instagram_business_manage_comments — the scope COMMENTS already proves —
    // NOT the Conversations API (MESSAGES, probed via /me/conversations).
    // A blocked/empty conversations probe must NOT refuse the campaign.
    // Ref: developers.facebook.com/documentation/instagram-platform/private-replies
    const result = evaluateInstagramFeature(
      "COMMENTS",
      registry({
        MESSAGES: capability("MESSAGES", "BLOCKED", "CONVERSATIONS_API_DENIED"),
      }),
      ["comments", "messages"],
      new Date(),
      ["comments", "messages"],
    );

    expect(result).toEqual({ ready: true, blockers: [] });
  });

  it("fails closed on Meta's comments-hidden evidence", () => {
    const result = evaluateInstagramFeature(
      "COMMENTS",
      registry({
        COMMENTS: capability("COMMENTS", "BLOCKED", "COMMENTS_HIDDEN_BY_META"),
      }),
      ["comments", "messages"],
      new Date(),
      ["comments", "messages"],
    );
    expect(result.ready).toBe(false);
    expect(result.blockers).toContain(
      "comments=BLOCKED:COMMENTS_HIDDEN_BY_META",
    );
  });

  it("does not let a successful subscription hide a stale capability probe", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T12:00:00Z"));
    const stale = capability("COMMENTS", "READY");
    stale.checkedAt = new Date("2026-08-29T12:00:00Z");
    const result = evaluateInstagramFeature(
      "COMMENTS",
      registry({ COMMENTS: stale }),
      ["comments"],
      new Date(),
      ["comments", "messages"],
    );
    expect(result.ready).toBe(false);
    expect(result.blockers).toContain("comments=STALE");
    vi.useRealTimers();
  });

  it("keeps insights independent from webhook subscriptions", () => {
    expect(
      evaluateInstagramFeature("INSIGHTS", registry(), [], null, []),
    ).toEqual({ ready: true, blockers: [] });
  });

  it("distinguishes account installation from app-level webhook fields", () => {
    const result = evaluateInstagramFeature(
      "MESSAGES",
      registry(),
      ["comments", "messages"],
      new Date(),
      ["comments", "messaging_postbacks", "messaging_seen"],
    );

    expect(result.ready).toBe(false);
    expect(result.blockers).toContain(
      "app_webhook_subscription=MISSING_messages",
    );
  });
});
