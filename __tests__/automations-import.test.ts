import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    automation: { findMany: vi.fn(), create: vi.fn() },
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: vi.fn(async () => ({
    workspaceId: "workspace_1",
    role: "OWNER",
  })),
  canManageCampaigns: vi.fn(() => true),
}));
vi.mock("@/lib/instagram-accounts", () => ({
  getWorkspaceInstagramAccount: vi.fn(async () => ({
    id: "account_1",
    username: "minibarmusic",
  })),
}));
vi.mock("@/lib/reports/share", () => ({
  generateReportShareSlug: vi.fn(() => "share-slug"),
}));
vi.mock("@/lib/tracking/server", () => ({
  generateTrackedLinkSlug: vi.fn(() => "tracked-slug"),
}));

import { POST } from "@/app/api/automations/import/route";

function request(campaigns: Record<string, unknown>[]) {
  return new Request("http://localhost/api/automations/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instagramAccountId: "account_1", campaigns }),
  });
}

const baseRow = {
  postId: "media_1",
  dmMessage: "Here is the link: {link}",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.automation.findMany.mockResolvedValue([]);
  mockPrisma.automation.create.mockImplementation(async ({ data }) => ({
    id: "automation_new",
    ...data,
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/automations/import matcher", () => {
  it("treats an empty keyword column as any comment", async () => {
    const response = await POST(
      request([{ ...baseRow, keywords: [] }]) as never
    );
    expect(response.status).toBe(200);

    expect(mockPrisma.automation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        keywords: [],
        matchAnyWord: true,
      }),
    });
  });

  it("keeps a filled keyword column on a specific word", async () => {
    const response = await POST(
      request([{ ...baseRow, keywords: ["LINK", "SHOP"] }]) as never
    );
    expect(response.status).toBe(200);

    expect(mockPrisma.automation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        keywords: ["LINK", "SHOP"],
        matchAnyWord: false,
      }),
    });
  });

  it("accepts a row that simply omits the keyword column", async () => {
    const response = await POST(request([{ ...baseRow }]) as never);
    expect(response.status).toBe(200);

    expect(mockPrisma.automation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ keywords: [], matchAnyWord: true }),
    });
  });
});
