import { describe, expect, it } from "vitest";
import {
  buildAssistantPayload,
  calendarCompletionPatch,
  defaultCampaignName,
} from "@/lib/assistant/payload";

const FACTS = {
  productId: 746990,
  sku: "LM-02",
  catnoTag: "LM02",
  hashtag: "#LM02",
  title: "Likemind 02",
  permalink: "https://yoyaku.io/release/nuro-fugue-nuron-likemind-02-lm-02/",
} as const;

const COPY = {
  openingDm: "Nuron & Fugue, Likemind 02 is back in stock.",
  openingButton: "Send the link",
  revealDm: "Here you go:",
  linkButton: "LM-02",
};

describe("defaultCampaignName", () => {
  it("reads “LM-02 · Likemind 02”, never “Campaign for @account”", () => {
    expect(defaultCampaignName({ sku: "LM-02", title: "Likemind 02" })).toBe(
      "LM-02 · Likemind 02"
    );
    expect(defaultCampaignName(FACTS)).not.toMatch(/Campaign for/);
  });
});

describe("buildAssistantPayload", () => {
  it("builds a catalogue-scope payload with the two-step DM on", () => {
    const payload = buildAssistantPayload({
      facts: FACTS,
      copy: COPY,
      scope: "catalogue",
      twoStep: true,
      instagramAccountId: "account_1",
      isActive: false,
    });

    expect(payload).toMatchObject({
      name: "LM-02 · Likemind 02",
      triggerType: "COMMENT",
      pendingNextReel: true,
      catnoTag: "LM02",
      postId: null,
      postUrl: null,
      matchAnyPost: false,
      matchAnyWord: true,
      keywords: [],
      dmMessage: "Here you go:",
      openingDmEnabled: true,
      openingDmMessage: "Nuron & Fugue, Likemind 02 is back in stock.",
      openingDmButtonLabel: "Send the link",
      trackedDestinationUrl: FACTS.permalink,
      linkButtonLabel: "LM-02",
      isActive: false,
    });
    expect(payload.publicReplyEnabled).toBe(false);
    expect(payload.publicReplyMessages).toEqual([]);
    expect(payload.requireFollow).toBe(false);
    expect(payload.followUpEnabled).toBe(false);
  });

  it("builds the LM-02 shape: specific-post scope with the two-step DM off", () => {
    const payload = buildAssistantPayload({
      facts: FACTS,
      copy: COPY,
      scope: "specific",
      postId: "media_1",
      postUrl: "https://instagram.com/reel/abc/",
      twoStep: false,
      instagramAccountId: "account_1",
      isActive: true,
    });

    expect(payload).toMatchObject({
      pendingNextReel: false,
      catnoTag: null,
      postId: "media_1",
      postUrl: "https://instagram.com/reel/abc/",
      dmMessage: "Here you go:",
      openingDmEnabled: false,
      openingDmMessage: null,
      openingDmButtonLabel: null,
      trackedDestinationUrl: FACTS.permalink,
    });
    expect(payload.publicReplyEnabled).toBe(false);
  });

  it("keeps publicReplyEnabled false on both scopes", () => {
    for (const scope of ["catalogue", "specific"] as const) {
      const payload = buildAssistantPayload({
        facts: FACTS,
        copy: COPY,
        scope,
        postId: "media_1",
        twoStep: scope === "catalogue",
        instagramAccountId: "account_1",
        isActive: true,
      });
      expect(payload.publicReplyEnabled).toBe(false);
      expect(payload.publicReplyMessages).toEqual([]);
    }
  });

  it("uses the editable name and truncates it to the API limit", () => {    const payload = buildAssistantPayload({
      facts: FACTS,
      copy: COPY,
      scope: "catalogue",
      twoStep: true,
      instagramAccountId: "account_1",
      isActive: false,
      name: "  Likemind 02 restock  ",
    });
    expect(payload.name).toBe("Likemind 02 restock");

    const long = buildAssistantPayload({
      facts: { ...FACTS, title: "T".repeat(200) },
      copy: COPY,
      scope: "catalogue",
      twoStep: true,
      instagramAccountId: "account_1",
      isActive: false,
    });
    expect(long.name.length).toBeLessThanOrEqual(100);
    expect(long.name).toBe(`LM-02 · ${"T".repeat(92)}`);
  });
});

describe("calendarCompletionPatch", () => {
  it("carries the copy fields only: no activation state, no binding, no destination", () => {
    const patch = calendarCompletionPatch({
      facts: FACTS,
      copy: COPY,
      twoStep: true,
      name: "LM-02 · Likemind 02",
    });

    expect(patch).toEqual({
      name: "LM-02 · Likemind 02",
      dmMessage: "Here you go:",
      openingDmEnabled: true,
      openingDmMessage: "Nuron & Fugue, Likemind 02 is back in stock.",
      openingDmButtonLabel: "Send the link",
      linkButtonLabel: "LM-02",
    });
    // The keys the Calendar PATCH guard would refuse must not be present at
    // all (omitted fields stay unchanged on the server).
    expect(patch).not.toHaveProperty("isActive");
    expect(patch).not.toHaveProperty("pendingNextReel");
    expect(patch).not.toHaveProperty("catnoTag");
    expect(patch).not.toHaveProperty("postId");
    expect(patch).not.toHaveProperty("postUrl");
    expect(patch).not.toHaveProperty("trackedDestinationUrl");
    expect(patch).not.toHaveProperty("instagramAccountId");
  });

  it("clears the opening DM with the two-step toggle off", () => {
    const patch = calendarCompletionPatch({
      facts: FACTS,
      copy: COPY,
      twoStep: false,
    });

    expect(patch.openingDmEnabled).toBe(false);
    expect(patch.openingDmMessage).toBeNull();
    expect(patch.openingDmButtonLabel).toBeNull();
  });
});
