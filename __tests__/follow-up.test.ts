import { describe, it, expect } from "vitest";
import { selectFollowUpRecipients } from "../lib/automations/follow-up";

/**
 * Plan F — one follow-up, only to people who tapped the link (24h window).
 */
describe("selectFollowUpRecipients", () => {
  const now = Date.parse("2026-10-07T12:00:00Z");
  const recent = new Date(now - 2 * 3600 * 1000); // 2h ago (inside 24h)
  const old = new Date(now - 30 * 3600 * 1000); // 30h ago (outside 24h)

  it("selects a SENT dmLog that has a matching click inside the window", () => {
    const out = selectFollowUpRecipients({
      dmLogs: [{ id: "dm1", status: "SENT", commenterId: "u1", createdAt: recent }],
      linkClicks: [{ dmLogId: "dm1" }],
      nowMs: now,
    });
    expect(out).toEqual([{ dmLogId: "dm1", commenterId: "u1" }]);
  });

  it("never selects a commenter who did not tap the link", () => {
    const out = selectFollowUpRecipients({
      dmLogs: [{ id: "dm1", status: "SENT", commenterId: "u1", createdAt: recent }],
      linkClicks: [],
      nowMs: now,
    });
    expect(out).toEqual([]);
  });

  it("skips a click outside the 24h window", () => {
    const out = selectFollowUpRecipients({
      dmLogs: [{ id: "dm1", status: "SENT", commenterId: "u1", createdAt: old }],
      linkClicks: [{ dmLogId: "dm1" }],
      nowMs: now,
    });
    expect(out).toEqual([]);
  });

  it("skips a non-SENT row and an already-followed-up row", () => {
    const dmLogs = [
      { id: "dm1", status: "FAILED", commenterId: "u1", createdAt: recent },
      { id: "dm2", status: "SENT", commenterId: "u2", createdAt: recent },
    ];
    const out = selectFollowUpRecipients({
      dmLogs,
      linkClicks: [{ dmLogId: "dm1" }, { dmLogId: "dm2" }],
      nowMs: now,
      followedUpIds: new Set(["dm2"]),
    });
    expect(out).toEqual([]);
  });
});
