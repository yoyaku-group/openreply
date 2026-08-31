import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  ping: vi.fn(),
  getJobCounts: vi.fn(),
  getWorkerHealth: vi.fn(),
  listCapabilities: vi.fn(),
  summarizeCapabilities: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: { $queryRaw: mocks.queryRaw },
}));
vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({ getJobCounts: mocks.getJobCounts }),
  getRedisConnection: () => ({ ping: mocks.ping }),
}));
vi.mock("@/lib/ops/worker-health", () => ({
  getWorkerHealth: mocks.getWorkerHealth,
}));
vi.mock("@/lib/meta/capabilities", () => ({
  listCachedInstagramCapabilities: mocks.listCapabilities,
  summarizeInstagramCapabilities: mocks.summarizeCapabilities,
}));

import { GET } from "../app/api/health/route";

describe("health capability enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queryRaw.mockResolvedValue([{ ok: 1 }]);
    mocks.ping.mockResolvedValue("PONG");
    mocks.getJobCounts.mockResolvedValue({ waiting: 0, active: 0, failed: 0 });
    mocks.getWorkerHealth.mockResolvedValue({
      healthy: true,
      heartbeat: null,
      ageMs: 0,
    });
    mocks.listCapabilities.mockResolvedValue([]);
  });

  it("returns 503 and the compatibility alias when an active comment flow is blocked", async () => {
    mocks.summarizeCapabilities.mockReturnValue({
      commentReadyCount: 0,
      messageReadyCount: 1,
      activeCommentBlockedCount: 1,
    });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.checks.instagram_scopes).toEqual(
      body.checks.instagram_capabilities,
    );
  });
});
