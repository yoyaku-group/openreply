import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockContext, mockPrisma, mockQueue, mockWorkerHealth, mockWorkerAlerts } = vi.hoisted(
  () => ({
    mockContext: vi.fn(),
    mockPrisma: {
      webhookEvent: { findMany: vi.fn() },
      dmLog: { findMany: vi.fn() },
      operationalEvent: { findMany: vi.fn() },
    },
    mockQueue: { getJobCounts: vi.fn() },
    mockWorkerHealth: vi.fn(),
    mockWorkerAlerts: vi.fn(),
  })
);

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/queue/client", () => ({ getDMQueue: () => mockQueue }));
vi.mock("@/lib/ops/worker-health", () => ({
  getWorkerHealth: mockWorkerHealth,
  getWorkerAlerts: mockWorkerAlerts,
}));
vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: mockContext,
  canViewGlobalDiagnostics: vi.fn((role: string) => role === "OWNER"),
}));

import { GET } from "@/app/api/admin/diagnostics/route";

const OWNER = {
  userId: "user_owner",
  workspaceId: "workspace_objects",
  workspace: { id: "workspace_objects" },
  role: "OWNER",
};

describe("GET /api/admin/diagnostics access", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockQueue.getJobCounts.mockResolvedValue({ waiting: 0, active: 0, delayed: 0, failed: 0 });
    mockWorkerHealth.mockResolvedValue({ healthy: true, ageMs: 0, heartbeat: null });
    mockWorkerAlerts.mockResolvedValue([]);
    mockPrisma.webhookEvent.findMany.mockResolvedValue([]);
    mockPrisma.dmLog.findMany.mockResolvedValue([]);
    mockPrisma.operationalEvent.findMany.mockResolvedValue([]);
  });

  it("rejects anonymous callers", async () => {
    mockContext.mockResolvedValue(null);

    expect((await GET()).status).toBe(401);
    expect(mockQueue.getJobCounts).not.toHaveBeenCalled();
  });

  it.each(["MEMBER", "EDITOR", "ADMIN"])("rejects %s because diagnostics are global", async (role) => {
    mockContext.mockResolvedValue({ ...OWNER, role });

    expect((await GET()).status).toBe(403);
    expect(mockQueue.getJobCounts).not.toHaveBeenCalled();
  });

  it("allows an owner and scopes persisted events to their active workspace", async () => {
    mockContext.mockResolvedValue(OWNER);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(mockPrisma.webhookEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: "workspace_objects", status: "FAILED" } })
    );
  });
});
