import { describe, it, expect } from "vitest";
import { buildTrackedUrl } from "../lib/tracking/message";

/**
 * Plan F — the tracked URL carries the DM log id so a click can be attributed
 * to the person who requested the link. Backward-compatible when absent.
 */
describe("buildTrackedUrl — DM attribution", () => {
  it("appends ?d=<dmLogId> when provided", () => {
    expect(buildTrackedUrl("abc", "https://open.yy.link", "dm_123")).toBe(
      "https://open.yy.link/r/abc?d=dm_123"
    );
  });

  it("stays clean without a dmLogId", () => {
    expect(buildTrackedUrl("abc", "https://open.yy.link")).toBe("https://open.yy.link/r/abc");
    expect(buildTrackedUrl("abc", "https://open.yy.link", null)).toBe("https://open.yy.link/r/abc");
  });
});
