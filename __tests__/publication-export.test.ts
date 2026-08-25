import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  getUserMediaPage: vi.fn(),
  decryptToken: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: { instagramAccount: { findFirst: mocks.findFirst } },
}));
vi.mock("@/lib/meta/client", () => ({ getUserMediaPage: mocks.getUserMediaPage }));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: mocks.decryptToken }));

import { GET } from "@/app/api/internal/publications/media/route";
import { NextRequest } from "next/server";

const SECRET = "test-only-".repeat(4);

function request(query: string, bearer = SECRET) {
  return new NextRequest(`http://localhost/api/internal/publications/media${query}`, {
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });
}

beforeEach(() => {
  process.env.PUBLICATION_EXPORT_SECRET = SECRET;
  vi.clearAllMocks();
  mocks.findFirst.mockResolvedValue({ username: "yoyakurecordstore", accessToken: "encrypted" });
  mocks.decryptToken.mockReturnValue("plain-meta-token");
  mocks.getUserMediaPage.mockResolvedValue({
    data: [{
      id: "media-1", caption: "#MB059 Sweely", media_type: "IMAGE",
      timestamp: "2026-08-25T12:00:00Z", permalink: "https://instagram.com/p/one/",
      media_url: "https://cdn.example.test/private.jpg", like_count: 12,
    }],
    nextCursor: "cursor_2",
  });
});

describe("GET /api/internal/publications/media", () => {
  it("fails closed on a missing, wrong, or short configured secret", async () => {
    expect((await GET(request("?account=yoyakurecordstore", ""))).status).toBe(401);
    expect((await GET(request("?account=yoyakurecordstore", "wrong"))).status).toBe(401);
    process.env.PUBLICATION_EXPORT_SECRET = "short";
    expect((await GET(request("?account=yoyakurecordstore", "short"))).status).toBe(401);
  });

  it("returns a signed, paginated, minimal proof DTO without Meta credentials", async () => {
    const response = await GET(request("?account=yoyakurecordstore&after=cursor_1&limit=500"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = await response.text();
    const timestamp = response.headers.get("x-yoyaku-timestamp")!;
    const expected = createHmac("sha256", SECRET).update(`${timestamp}.${body}`).digest("hex");
    expect(response.headers.get("x-yoyaku-signature")).toBe(`sha256=${expected}`);
    const json = JSON.parse(body);
    expect(json.data.next_cursor).toBe("cursor_2");
    expect(json.data.complete).toBe(false);
    expect(json.data.media[0]).toEqual({
      account_owner: "yoyakurecordstore",
      external_id: "media-1",
      permalink: "https://instagram.com/p/one/",
      caption: "#MB059 Sweely",
      published_at: "2026-08-25T12:00:00Z",
      media_type: "IMAGE",
    });
    expect(body).not.toContain("plain-meta-token");
    expect(body).not.toContain("encrypted");
    expect(body).not.toContain("private.jpg");
    expect(mocks.getUserMediaPage).toHaveBeenCalledWith("plain-meta-token", "cursor_1", 100);
  });

  it("validates account and cursor before touching Prisma or Meta", async () => {
    expect((await GET(request("?account=bad%20account"))).status).toBe(400);
    expect((await GET(request("?account=yoyakurecordstore&after=%2Fetc%2Fpasswd"))).status).toBe(400);
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(mocks.getUserMediaPage).not.toHaveBeenCalled();
  });

  it("returns a signed 404 for an unknown account", async () => {
    mocks.findFirst.mockResolvedValue(null);
    const response = await GET(request("?account=missing.account"));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ success: false, error: "account_not_found" });
    expect(response.headers.get("x-yoyaku-signature")).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
});
