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

  it("resets only SENDING rows older than the threshold to FAILED", async () => {
    mockUpdateMany.mockResolvedValue({ count: 2 });

    const reclaimed = await reclaimStaleSendingClaims();

    expect(reclaimed).toBe(2);
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    const arg = mockUpdateMany.mock.calls[0][0];
    // Only SENDING rows past the staleness cutoff — never a fresh in-flight claim.
    expect(arg.where.status).toBe("SENDING");
    expect(arg.where.updatedAt.lt).toBeInstanceOf(Date);
    // Reclaim to FAILED (never PENDING) — no resend, no double-DM risk.
    expect(arg.data.status).toBe("FAILED");
  });

  it("uses a cutoff comfortably in the past (>> the send window)", async () => {
    const before = Date.now();
    await reclaimStaleSendingClaims();
    const cutoff: Date = mockUpdateMany.mock.calls[0][0].where.updatedAt.lt;
    // Default threshold is 15 min; the cutoff must be at least a few minutes old
    // so a live in-flight claim (seconds old) is never swept.
    expect(before - cutoff.getTime()).toBeGreaterThanOrEqual(60_000);
  });

  it("returns 0 when nothing is stale", async () => {
    expect(await reclaimStaleSendingClaims()).toBe(0);
  });
});
