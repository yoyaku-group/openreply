import { describe, expect, it } from "vitest";
import {
  calculateCtr,
  formatCtr,
  normalizeTopKeywords,
  summarizeClicks,
  summarizeDmStatuses,
} from "../lib/tracking/analytics";
import {
  buildTrackedUrl,
  extractFirstUrl,
  renderMessageWithTracking,
  replaceUrlWithTrackedPlaceholder,
} from "../lib/tracking/message";

describe("tracked link messages", () => {
  it("extracts a destination URL and replaces it with the tracked placeholder", () => {
    const message =
      "Hey {username}, here is your guide: https://example.com/guide.";
    const url = extractFirstUrl(message);

    expect(url).toBe("https://example.com/guide");
    expect(replaceUrlWithTrackedPlaceholder(message, url)).toBe(
      "Hey {username}, here is your guide: {link}."
    );
  });

  it("renders tracked URLs with username personalization", () => {
    expect(
      renderMessageWithTracking({
        message: "Hey {username}, grab it here: {link}",
        commenterName: "Maya",
        trackedLinks: [
          {
            slug: "abc123",
            destinationUrl: "https://example.com/guide",
          },
        ],
        baseUrl: "https://manychat-alternative.com",
      })
    ).toBe("Hey Maya, grab it here: https://manychat-alternative.com/r/abc123");
  });

  it("can replace a raw destination URL when the placeholder is missing", () => {
    expect(
      renderMessageWithTracking({
        message: "Link: https://example.com/guide",
        trackedLinks: [
          {
            slug: "abc123",
            destinationUrl: "https://example.com/guide",
          },
        ],
        baseUrl: "https://manychat-alternative.com/",
      })
    ).toBe("Link: https://manychat-alternative.com/r/abc123");
  });

  it("matches normalized root URLs with or without trailing slash", () => {
    expect(
      replaceUrlWithTrackedPlaceholder("Link: https://example.com", "https://example.com/")
    ).toBe("Link: {link}");
    expect(
      renderMessageWithTracking({
        message: "Link: https://example.com",
        trackedLinks: [
          {
            slug: "abc123",
            destinationUrl: "https://example.com/",
          },
        ],
        baseUrl: "https://manychat-alternative.com",
      })
    ).toBe("Link: https://manychat-alternative.com/r/abc123");
  });

  it("builds redirect URLs from a base URL", () => {
    expect(buildTrackedUrl("abc123", "https://manychat-alternative.com/")).toBe(
      "https://manychat-alternative.com/r/abc123"
    );
  });
});

describe("campaign analytics helpers", () => {
  it("summarizes DM status rows", () => {
    expect(
      summarizeDmStatuses([
        { status: "SENT", _count: 20 },
        { status: "FAILED", _count: 2 },
        { status: "SKIPPED_RATE_LIMIT", _count: 3 },
        { status: "SKIPPED_PLAN_LIMIT", _count: 1 },
      ])
    ).toEqual({ sent: 20, skipped: 4, failed: 2 });
  });

  it("calculates the click rate from unique clickers over DMs sent", () => {
    expect(calculateCtr(5, 20)).toBe(0.25);
    expect(calculateCtr(2, 3)).toBe(0.667);
    expect(calculateCtr(0, 10)).toBe(0);
  });

  it("reports an unknown click rate when nothing was sent", () => {
    expect(calculateCtr(0, 0)).toBeNull();
    expect(calculateCtr(5, 0)).toBeNull();
  });

  it("formats a click rate for display, keeping unknown distinct from zero", () => {
    expect(formatCtr(0.25)).toBe("25%");
    expect(formatCtr(0)).toBe("0%");
    expect(formatCtr(null)).toBe("unknown");
  });

  it("counts distinct DMs as clickers, not raw clicks", () => {
    // Three clicks from one DM (one person re-opening) and one from another:
    // 4 raw clicks, but only 2 DMs actually clicked out of 10 sent.
    const summary = summarizeClicks(
      4,
      [{ dmLogId: "dmlog_a" }, { dmLogId: "dmlog_b" }],
      10
    );

    expect(summary).toEqual({ clicks: 4, uniqueClickers: 2, ctr: 0.2 });
  });

  it("reports an unknown rate when no DM was sent", () => {
    expect(summarizeClicks(0, [], 0)).toEqual({
      clicks: 0,
      uniqueClickers: 0,
      ctr: null,
    });
  });

  it("never counts unattributable clicks as clickers", () => {
    expect(
      summarizeClicks(3, [{ dmLogId: null }, { dmLogId: "dmlog_a" }], 4)
    ).toEqual({ clicks: 3, uniqueClickers: 1, ctr: 0.25 });
  });

  it("normalizes top keywords by count", () => {
    expect(
      normalizeTopKeywords([
        { matchedKeyword: "PRICE", _count: 3 },
        { matchedKeyword: null, _count: 9 },
        { matchedKeyword: "LINK", _count: 7 },
      ])
    ).toEqual([
      { keyword: "LINK", count: 7 },
      { keyword: "PRICE", count: 3 },
    ]);
  });
});
