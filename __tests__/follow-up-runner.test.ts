import { describe, it, expect, vi, afterEach } from "vitest";
import { runFollowUps } from "../lib/automations/follow-up-runner";

/**
 * Plan F — the follow-up job. Dormant by default; sends once per clicker.
 */

const OLD = process.env.FOLLOW_UP_REMINDER_ENABLED;
afterEach(() => { if (OLD === undefined) delete process.env.FOLLOW_UP_REMINDER_ENABLED; else process.env.FOLLOW_UP_REMINDER_ENABLED = OLD; });

function makePrisma(dmLogs: any[], clicks: any[]) {
  const update = vi.fn().mockResolvedValue({});
  return {
    prisma: {
      dmLog: { findMany: vi.fn().mockResolvedValue(dmLogs), update },
      linkClick: { findMany: vi.fn().mockResolvedValue(clicks) },
    },
    update,
  };
}

describe("runFollowUps", () => {
  const now = Date.parse("2026-10-07T12:00:00Z");
  const recent = new Date(now - 2 * 3600 * 1000);

  it("is a no-op while FOLLOW_UP_REMINDER_ENABLED is off", async () => {
    delete process.env.FOLLOW_UP_REMINDER_ENABLED;
    const { prisma } = makePrisma([], []);
    const out = await runFollowUps({ prisma: prisma as any, send: vi.fn(), nowMs: now });
    expect(out.enabled).toBe(false);
    expect(prisma.dmLog.findMany).not.toHaveBeenCalled();
  });

  it("sends once to a clicker and records followUpSentAt", async () => {
    process.env.FOLLOW_UP_REMINDER_ENABLED = "1";
    const { prisma, update } = makePrisma(
      [{ id: "dm1", status: "SENT", commenterId: "u1", createdAt: recent }],
      [{ dmLogId: "dm1" }],
    );
    const send = vi.fn().mockResolvedValue(undefined);
    const out = await runFollowUps({ prisma: prisma as any, send, nowMs: now });
    expect(out).toMatchObject({ enabled: true, sent: 1, candidates: 1 });
    expect(send).toHaveBeenCalledWith("dm1");
    expect(update).toHaveBeenCalledWith({ where: { id: "dm1" }, data: { followUpSentAt: new Date(now) } });
  });

  it("never sends to a non-clicker", async () => {
    process.env.FOLLOW_UP_REMINDER_ENABLED = "1";
    const { prisma } = makePrisma(
      [{ id: "dm1", status: "SENT", commenterId: "u1", createdAt: recent }],
      [],
    );
    const send = vi.fn();
    const out = await runFollowUps({ prisma: prisma as any, send, nowMs: now });
    expect(out.sent).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});
