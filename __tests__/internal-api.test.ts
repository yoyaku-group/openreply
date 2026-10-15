import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    automation: { findMany: vi.fn() },
    dmLog: { count: vi.fn() },
    linkClick: { count: vi.fn() },
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import { POST as lintCopy } from "@/app/api/internal/lint-copy/route";
import { GET as campaignStats } from "@/app/api/internal/campaign-stats/route";
import { NextRequest } from "next/server";

const SECRET = "test-only-secret-".repeat(3);

function lintRequest(body: unknown, auth: string | null = `Bearer ${SECRET}`) {
  return new NextRequest("http://localhost/api/internal/lint-copy", {
    method: "POST",
    headers: auth ? { authorization: auth } : {},
    body: JSON.stringify(body),
  });
}

function statsRequest(query: string, auth: string | null = `Bearer ${SECRET}`) {
  return new NextRequest(`http://localhost/api/internal/campaign-stats${query}`, {
    headers: auth ? { authorization: auth } : {},
  });
}

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  process.env.CALENDAR_WORKSPACE_IDS = "yoyaku=workspace_yoyaku_123";
  vi.clearAllMocks();
});

describe("POST /api/internal/lint-copy", () => {
  it("rejects a missing or wrong bearer", async () => {
    expect((await lintCopy(lintRequest({ text: "x" }, null))).status).toBe(401);
    expect((await lintCopy(lintRequest({ text: "x" }, "Bearer nope"))).status).toBe(401);
  });

  it("flags style violations on a ManyChat-style caption", async () => {
    const res = await lintCopy(
      lintRequest({ text: "Hey! 🌟 Dive into this fresh perspective!" })
    );
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.ok).toBe(false);
    const rules = json.data.violations.map((v: { rule: string }) => v.rule);
    expect(rules).toContain("no-emoji");
    expect(rules).toContain("cliche");
  });

  it("does not flag proper nouns when no fact block is supplied", async () => {
    const res = await lintCopy(
      lintRequest({ text: "Aleksi Perala, Cycles. Preorder is open on Trip." })
    );
    const json = await res.json();
    expect(json.data.ok).toBe(true);
  });

  it("still enforces the noun rule when nouns are supplied", async () => {
    const res = await lintCopy(
      lintRequest({ text: "Out now on Rekids.", nouns: ["Trip"] })
    );
    const json = await res.json();
    expect(json.data.ok).toBe(false);
    expect(json.data.violations.some((v: { rule: string }) => v.rule === "invented-noun")).toBe(true);
  });
});

describe("GET /api/internal/campaign-stats", () => {
  it("rejects a missing bearer and a missing sku", async () => {
    expect((await campaignStats(statsRequest("?sku=X", null))).status).toBe(401);
    expect((await campaignStats(statsRequest(""))).status).toBe(400);
  });

  it("returns null when no campaign matches the catno", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    const res = await campaignStats(statsRequest("?sku=NOPE1&workspace_key=yoyaku&account_owner=yoyakurecordstore&publication_key=calendar:nope"));
    const json = await res.json();
    expect(json.data.automation).toBeNull();
    expect(mockPrisma.automation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ catnoTag: { equals: "NOPE1", mode: "insensitive" }, publicationKey:"calendar:nope",workspaceId:"workspace_yoyaku_123" }),
      })
    );
  });

  it("returns the exact scoped campaign with SENT + click counts", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([{
      id: "a1",
      name: "HCLP008",
      triggerType: "COMMENT",
      keywords: ["LINK"],
      isActive: true,
      postId: "p1",
      createdAt: new Date(0),
    }]);
    mockPrisma.dmLog.count.mockResolvedValue(37);
    mockPrisma.linkClick.count.mockResolvedValue(35);
    const res = await campaignStats(statsRequest("?sku=hclp008&workspace_key=yoyaku&account_owner=yoyakurecordstore&publication_key=calendar:preorder"));
    const json = await res.json();
    expect(json.data.automation).toMatchObject({
      id: "a1",
      triggerType: "COMMENT",
      keywords: ["LINK"],
      dmSent: 37,
      clicks: 35,
    });
    expect(mockPrisma.dmLog.count).toHaveBeenCalledWith({
      where: { automationId: "a1", workspaceId:"workspace_yoyaku_123", status: "SENT" },
    });
  });

  it("returns the exact inbound keyword for non-post campaigns", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([{
      id: "a2",
      name: "MB059",
      triggerType: "INBOUND_DM",
      keywords: ["MB059"],
      isActive: true,
      postId: null,
      createdAt: new Date(0),
    }]);
    mockPrisma.dmLog.count.mockResolvedValue(4);
    mockPrisma.linkClick.count.mockResolvedValue(3);

    const res = await campaignStats(statsRequest("?sku=MB059&workspace_key=yoyaku&account_owner=yoyakurecordstore&automation_id=a2"));
    const json = await res.json();

    expect(json.data.automation).toMatchObject({
      triggerType: "INBOUND_DM",
      keywords: ["MB059"],
      postId: null,
    });
  });
});
