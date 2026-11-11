import { describe, expect, it } from "vitest";
import { generateCopy, releaseFactsFrom } from "@/lib/assistant/generate-copy";
import type { ProductFacts } from "@/lib/assistant/resolve-product";

const LM02_FACTS: ProductFacts = {
  productId: 746990,
  sku: "LM-02",
  catnoTag: "LM02",
  hashtag: "#LM02",
  title: "Likemind 02",
  artists: ["Nuron", "Fugue"],
  label: "Blueprint ARchives",
  permalink: "https://yoyaku.io/release/nuro-fugue-nuron-likemind-02-lm-02/",
  imageUrl: null,
  description: "Blueprint ARchives presents a reissue of Likemind 02.",
  state: "restock",
  missing: [],
};

describe("generateCopy", () => {
  it("produces lint-clean standard copy from the LM-02 facts", () => {
    const result = generateCopy(LM02_FACTS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provenance).toBe("standard");
    expect(result.lint.ok).toBe(true);
    // The restock shell keeps the artists in the joined order.
    expect(result.openingDm).toBe("Nuron & Fugue, Likemind 02 is back in stock.");
    expect(result.revealDm).toMatch(/^(Here|There) you go:$/);
    expect(result.openingButton.length).toBeGreaterThan(0);
    expect(result.openingButton.length).toBeLessThanOrEqual(20);
    expect(result.linkButton).toBe("LM-02");
    // The copy never mentions the caption when none was given.
    expect(result.openingDm).not.toContain("#");
  });

  it("fails with MISSING_FACTS instead of inventing values", () => {
    const result = generateCopy({
      ...LM02_FACTS,
      artists: [],
      label: null,
      title: "",
      missing: ["artist", "label"],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("MISSING_FACTS");
    expect(result.missing).toEqual(
      expect.arrayContaining(["artist", "title", "label"])
    );
  });

  it("maps preorder to the preorder shells and keeps the SKU as catno", () => {
    const result = generateCopy({ ...LM02_FACTS, state: "preorder" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Preorder button carries the reference; the copy never uses the hashtag
    // form as the catno.
    expect(result.linkButton).toMatch(/LM-02/);
    expect(result.linkButton).not.toContain("#");
    expect(result.copy.trackedDestinationUrl).toBe(LM02_FACTS.permalink);
  });
});

describe("releaseFactsFrom", () => {
  it("joins artists with an ampersand and maps the state", () => {
    const mapped = releaseFactsFrom(LM02_FACTS);
    expect(mapped.artist).toBe("Nuron & Fugue");
    expect(mapped.catno).toBe("LM-02");
    expect(mapped.eventType).toBe("restock");
    expect(mapped.url).toBe(LM02_FACTS.permalink);

    const preorder = releaseFactsFrom({ ...LM02_FACTS, state: "preorder" });
    expect(preorder.eventType).toBe("preorder_open");

    const live = releaseFactsFrom({ ...LM02_FACTS, state: "coming_soon" });
    expect(live.eventType).toBe("release_live");
  });
});
