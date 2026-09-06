import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockUpdateMany } = vi.hoisted(() => ({
  mockUpdateMany: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: { dmLog: { updateMany: mockUpdateMany } },
}));

import { reclaimStaleSendingClaims } from "../lib/queue/reclaim-sending-claims";

describe("reclaimStaleSendingClaims", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateMany.mockResolvedValue({ count: 0 });
  });

  it("reclaims only SENDING rows older than BOTH the worker boot time and the floor, to FAILED", async () => {
    mockUpdateMany.mockResolvedValue({ count: 2 });
    const workerStartedAt = new Date("2026-09-06T12:00:00Z");

    const reclaimed = await reclaimStaleSendingClaims(workerStartedAt);

    expect(reclaimed).toBe(2);
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    const arg = mockUpdateMany.mock.calls[0][0];
    expect(arg.where.status).toBe("SENDING");
    // Condition 1: claimed before THIS worker instance booted (never a live
    // same-instance claim). Condition 2: also older than the absolute floor.
    const bounds = arg.where.AND.map(
      (c: { updatedAt: { lt: Date } }) => c.updatedAt.lt
    );
    expect(bounds).toContainEqual(workerStartedAt);
    expect(bounds.every((d: Date) => d instanceof Date)).toBe(true);
    // Reclaim to FAILED (never PENDING) — no resend, no double-DM risk.
    expect(arg.data.status).toBe("FAILED");
  });

  it("uses a floor comfortably in the past (>> the send window)", async () => {
    const before = Date.now();
    await reclaimStaleSendingClaims(new Date());
    const bounds: Date[] = mockUpdateMany.mock.calls[0][0].where.AND.map(
      (c: { updatedAt: { lt: Date } }) => c.updatedAt.lt
    );
    // The floor (the non-boot bound) is at least a minute old.
    const floor = bounds.reduce((a, b) => (a.getTime() < b.getTime() ? a : b));
    expect(before - floor.getTime()).toBeGreaterThanOrEqual(60_000);
  });

  it("never sweeps a claim newer than the worker boot time (live in-flight send)", async () => {
    // A live same-instance claim has updatedAt >= boot; condition 1 excludes it.
    // We assert the boot-time bound is present so such rows can never match.
    await reclaimStaleSendingClaims(new Date("2026-09-06T12:00:00Z"));
    const bounds: Date[] = mockUpdateMany.mock.calls[0][0].where.AND.map(
      (c: { updatedAt: { lt: Date } }) => c.updatedAt.lt
    );
    expect(bounds).toContainEqual(new Date("2026-09-06T12:00:00Z"));
  });

  it("returns 0 when nothing is stale", async () => {
    expect(await reclaimStaleSendingClaims(new Date())).toBe(0);
  });
});
