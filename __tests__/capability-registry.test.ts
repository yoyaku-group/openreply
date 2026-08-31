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
      ),
    ).toEqual({ ready: true, blockers: [] });
  });

  it("fails closed on Meta's comments-hidden evidence", () => {
    const result = evaluateInstagramFeature(
      "COMMENTS",
      registry({
        COMMENTS: capability("COMMENTS", "BLOCKED", "COMMENTS_HIDDEN_BY_META"),
      }),
      ["comments", "messages"],
      new Date(),
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
    );
    expect(result.ready).toBe(false);
    expect(result.blockers).toContain("comments=STALE");
    vi.useRealTimers();
  });

  it("keeps insights independent from webhook subscriptions", () => {
    expect(evaluateInstagramFeature("INSIGHTS", registry(), [], null)).toEqual({
      ready: true,
      blockers: [],
    });
  });
});
