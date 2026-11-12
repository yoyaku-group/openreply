import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockPrisma, serviceMocks, accessMocks } = vi.hoisted(() => ({
  mockPrisma: {
    automation: { findFirst: vi.fn() },
  },
  serviceMocks: {
    getGenerationStatus: vi.fn(),
    recordFinalCopy: vi.fn(),
  },
  accessMocks: {
    getCurrentWorkspaceContext: vi.fn(),
    canManageCampaigns: vi.fn(() => true),
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/copywriter/service", () => serviceMocks);
vi.mock("@/lib/workspace-access", () => accessMocks);

import { GET, PATCH } from "@/app/api/assistant/generations/[id]/route";

const params = { params: Promise.resolve({ id: "gen_1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  accessMocks.getCurrentWorkspaceContext.mockResolvedValue({
    workspaceId: "workspace_1",
    role: "OWNER",
  });
  mockPrisma.automation.findFirst.mockResolvedValue({ id: "automation_1" });
  serviceMocks.recordFinalCopy.mockResolvedValue({ editDistance: 12 });
});

describe("GET /api/assistant/generations/[id]", () => {
  it("returns the status for the workspace", async () => {
    serviceMocks.getGenerationStatus.mockResolvedValue({
      status: "DONE",
      copy: { openingDm: "a", openingButton: "b", revealDm: "c", linkButton: "d" },
      promptVersion: 1,
      tier: "claude",
    });
    const response = await GET(new NextRequest("http://localhost/x"), params);
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.data.status).toBe("DONE");
    expect(serviceMocks.getGenerationStatus).toHaveBeenCalledWith(
      "gen_1",
      "workspace_1"
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("answers 404 when the generation belongs to another workspace", async () => {
    serviceMocks.getGenerationStatus.mockResolvedValue(null);
    const response = await GET(new NextRequest("http://localhost/x"), params);
    expect(response.status).toBe(404);
  });

  it("requires a session", async () => {
    accessMocks.getCurrentWorkspaceContext.mockResolvedValue(null);
    const response = await GET(new NextRequest("http://localhost/x"), params);
    expect(response.status).toBe(401);
    expect(serviceMocks.getGenerationStatus).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/assistant/generations/[id] (record final copy)", () => {
  const body = {
    automationId: "automation_1",
    finalCopy: {
      openingDm: "a",
      openingButton: "b",
      revealDm: "c",
      linkButton: "d",
    },
  };

  it("records the validated copy on the generation", async () => {
    const response = await PATCH(
      new NextRequest("http://localhost/x", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      params
    );
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.data).toEqual({ editDistance: 12 });
    expect(mockPrisma.automation.findFirst).toHaveBeenCalledWith({
      where: { id: "automation_1", workspaceId: "workspace_1" },
      select: { id: true },
    });
    expect(serviceMocks.recordFinalCopy).toHaveBeenCalledWith(
      "gen_1",
      "workspace_1",
      { automationId: "automation_1", finalCopy: body.finalCopy }
    );
  });

  it("refuses a campaign from another workspace", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(null);
    const response = await PATCH(
      new NextRequest("http://localhost/x", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      params
    );
    expect(response.status).toBe(404);
    expect(serviceMocks.recordFinalCopy).not.toHaveBeenCalled();
  });

  it("refuses a malformed body", async () => {
    const response = await PATCH(
      new NextRequest("http://localhost/x", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ automationId: "automation_1" }),
      }),
      params
    );
    expect(response.status).toBe(400);
  });

  it("refuses members who cannot manage campaigns", async () => {
    accessMocks.canManageCampaigns.mockReturnValue(false);
    const response = await PATCH(
      new NextRequest("http://localhost/x", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      params
    );
    expect(response.status).toBe(403);
  });
});
