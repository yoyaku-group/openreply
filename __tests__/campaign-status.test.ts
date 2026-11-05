import { describe, expect, it } from "vitest";
import { campaignStatus } from "@/lib/automations/status";

describe("campaignStatus", () => {
  it("keeps an explicitly paused waiting campaign distinct from a draft", () => {
    expect(campaignStatus({ isActive: false, pendingNextReel: true,
      catnoTag: "ABC001", lifecycle: "PAUSED" }).key).toBe("paused");
  });

  it("keeps a draft unapproved after attachment", () => {
    expect(campaignStatus({ isActive: false, pendingNextReel: false,
      postId: "media_1", catnoTag: "ABC001", lifecycle: "PLANNED" }).key).toBe("draft");
  });

  it("does not label a generic campaign active before publication", () => {
    expect(campaignStatus({ isActive: true, pendingNextReel: true })).toEqual({
      key: "waiting", label: "Waiting for next post or reel",
    });
  });
  it("labels an armed catalogue campaign as waiting, never LIVE", () => {
    const status = campaignStatus({
      isActive: true,
      pendingNextReel: true,
      postId: null,
      catnoTag: "ABC001",
    });
    expect(status).toEqual({
      key: "waiting",
      label: "Waiting for #ABC001",
    });
  });

  it("labels an inactive waiting catalogue campaign as a draft", () => {
    expect(
      campaignStatus({
        isActive: false,
        pendingNextReel: true,
        postId: null,
        catnoTag: "ABC001",
      }).key
    ).toBe("draft");
  });

  it("labels a bound active campaign as active", () => {
    expect(
      campaignStatus({
        isActive: true,
        pendingNextReel: false,
        postId: "media_1",
        catnoTag: "ABC001",
      }).key
    ).toBe("active");
  });

  it("labels an unbound inactive campaign without a tag as a draft", () => {
    expect(
      campaignStatus({
        isActive: false,
        pendingNextReel: true,
        postId: null,
      }).key
    ).toBe("draft");
  });

  it("lets needs-attention override every other state", () => {
    expect(
      campaignStatus({
        isActive: true,
        pendingNextReel: true,
        catnoTag: "ABC001",
        lifecycle: "NEEDS_ATTENTION",
      })
    ).toEqual({ key: "needs_attention", label: "Needs attention" });
  });

  it("labels a stopped bound campaign as paused", () => {
    expect(
      campaignStatus({
        isActive: false,
        pendingNextReel: false,
        postId: "media_1",
        catnoTag: "ABC001",
      }).key
    ).toBe("paused");
  });
});
