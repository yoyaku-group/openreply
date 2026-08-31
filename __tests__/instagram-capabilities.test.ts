import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getInstagramWebhookSubscriptions,
  probeInstagramCapabilities,
} from "../lib/meta/client";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.stubEnv("META_GRAPH_API_VERSION", "v23.0");
});

describe("probeInstagramCapabilities", () => {
  it("marks comments READY only when a known-commented media returns visible comments", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/me?fields=id,username")) {
          return jsonResponse({ id: "app-scoped", username: "yoyaku.fr" });
        }
        if (url.includes("/me/conversations")) {
          return jsonResponse({ data: [] });
        }
        if (url.includes("/me/media")) {
          return jsonResponse({
            data: [{ id: "media-1", comments_count: 12 }],
          });
        }
        if (url.includes("/media-1/comments")) {
          return jsonResponse({ data: [{ id: "comment-1" }] });
        }
        if (url.includes("/media-1/insights")) {
          return jsonResponse({ data: [] });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    const result = await probeInstagramCapabilities("token");

    expect(result.BASIC.status).toBe("READY");
    expect(result.MESSAGES.status).toBe("READY");
    expect(result.COMMENTS).toMatchObject({
      status: "READY",
      reason: "COMMENTS_VISIBLE",
    });
    expect(result.INSIGHTS.status).toBe("READY");
    expect(result.CONTENT_PUBLISH).toMatchObject({
      status: "UNKNOWN",
      reason: "NOT_REQUESTED",
    });
  });

  it("marks comments BLOCKED when Meta reports comments_count but hides the collection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/me?fields=id,username")) {
          return jsonResponse({ id: "app-scoped", username: "yoyaku.fr" });
        }
        if (url.includes("/me/conversations")) {
          return jsonResponse({ data: [] });
        }
        if (url.includes("/me/media")) {
          return jsonResponse({
            data: [{ id: "media-1", comments_count: 12 }],
          });
        }
        if (url.includes("/media-1/comments")) {
          return jsonResponse({ data: [] });
        }
        if (url.includes("/media-1/insights")) {
          return jsonResponse({ data: [] });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    const result = await probeInstagramCapabilities("token");

    expect(result.COMMENTS).toMatchObject({
      status: "BLOCKED",
      reason: "COMMENTS_HIDDEN_BY_META",
      evidence: {
        mediaId: "media-1",
        commentsCount: 12,
        visibleComments: 0,
      },
    });
  });

  it("checks more than the first commented media before declaring comments blocked", async () => {
    const requestedCommentMedia: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/me?fields=id,username")) {
          return jsonResponse({ id: "app-scoped", username: "objects.press" });
        }
        if (url.includes("/me/conversations")) {
          return jsonResponse({ data: [] });
        }
        if (url.includes("/me/media")) {
          return jsonResponse({
            data: [
              { id: "media-hidden", comments_count: 4 },
              { id: "media-visible", comments_count: 2 },
            ],
          });
        }
        if (url.includes("/media-hidden/comments")) {
          requestedCommentMedia.push("media-hidden");
          return jsonResponse({ data: [] });
        }
        if (url.includes("/media-visible/comments")) {
          requestedCommentMedia.push("media-visible");
          return jsonResponse({ data: [{ id: "comment-visible" }] });
        }
        if (url.includes("/media-hidden/insights")) {
          return jsonResponse({ data: [] });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    const result = await probeInstagramCapabilities("token");

    expect(requestedCommentMedia).toEqual(["media-hidden", "media-visible"]);
    expect(result.COMMENTS).toMatchObject({
      status: "READY",
      reason: "COMMENTS_VISIBLE",
      evidence: { mediaId: "media-visible", visibleComments: 1 },
    });
  });

  it("keeps transient comment probe failures distinct from permission blocks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/me?fields=id,username")) {
          return jsonResponse({ id: "app-scoped", username: "objects.press" });
        }
        if (url.includes("/me/conversations")) {
          return jsonResponse({ data: [] });
        }
        if (url.includes("/me/media")) {
          return jsonResponse({
            data: [{ id: "media-rate-limited", comments_count: 4 }],
          });
        }
        if (url.includes("/media-rate-limited/comments")) {
          return jsonResponse({ error: "try again" }, 503);
        }
        if (url.includes("/media-rate-limited/insights")) {
          return jsonResponse({ data: [] });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    const result = await probeInstagramCapabilities("token");

    expect(result.COMMENTS).toMatchObject({
      status: "ERROR",
      reason: "COMMENTS_API_TRANSIENT_ERROR",
    });
  });

  it("keeps comments UNKNOWN when no sampled media can prove comment visibility", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/me?fields=id,username")) {
          return jsonResponse({ id: "app-scoped", username: "empty" });
        }
        if (url.includes("/me/conversations")) {
          return jsonResponse({ data: [] });
        }
        if (url.includes("/me/media")) {
          return jsonResponse({ data: [{ id: "media-1", comments_count: 0 }] });
        }
        if (url.includes("/media-1/insights")) {
          return jsonResponse({ data: [] });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    const result = await probeInstagramCapabilities("token");

    expect(result.COMMENTS).toMatchObject({
      status: "UNKNOWN",
      reason: "NO_COMMENTED_MEDIA",
    });
  });
});

describe("getInstagramWebhookSubscriptions", () => {
  it("reads back and normalizes the fields Meta actually subscribed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        expect(init?.headers).toMatchObject({ Authorization: "Bearer token" });
        return jsonResponse({
          data: [
            { subscribed_fields: ["messages", "comments"] },
            { subscribed_fields: ["comments"] },
          ],
        });
      }),
    );

    await expect(
      getInstagramWebhookSubscriptions("ig-1", "token"),
    ).resolves.toEqual(["comments", "messages"]);
  });
});
