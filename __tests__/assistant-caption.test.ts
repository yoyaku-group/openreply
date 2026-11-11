import { describe, expect, it } from "vitest";
import { composeCaption } from "@/lib/assistant/caption";
import { CTA_BY_STATE, ctaFor } from "@/lib/assistant/caption-cta";
import type { ProductFacts } from "@/lib/assistant/resolve-product";

const facts = (overrides: Partial<ProductFacts> = {}): ProductFacts => ({
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
  ...overrides,
});

const CTA = "Comment to get the link!";

describe("ctaFor", () => {
  it("uses the pre-order wording for preorder and the link wording elsewhere", () => {
    expect(ctaFor("preorder")).toBe("Comment to pre-order!");
    expect(ctaFor("restock")).toBe("Comment to get the link!");
    expect(ctaFor("coming_soon")).toBe("Comment to get the link!");
    expect(ctaFor("available")).toBe("Comment to get the link!");
    expect(CTA_BY_STATE.preorder).toBe("Comment to pre-order!");
  });
});

describe("composeCaption", () => {
  it("returns no final caption but lists the lines to add when there is no caption", () => {
    const result = composeCaption({ facts: facts(), cta: CTA });

    expect(result.final).toBeNull();
    expect(result.additions).toEqual([CTA, "#LM02"]);
    expect(
      result.checks.some((c) => c.code === "REFERENCE_MISSING")
    ).toBe(true);
    expect(result.checks.some((c) => c.code === "CTA_MISSING")).toBe(true);
    // Paste-only warnings stay out when nothing was pasted.
    expect(result.checks.some((c) => c.code === "PRICE_IN_CAPTION")).toBe(false);
    expect(result.checks.some((c) => c.code === "URL_IN_CAPTION")).toBe(false);
  });

  it("adds the hashtag on its own last line when the reference is missing", () => {
    const caption = "Nuron and Fugue are back.\nOut now on the shop.";
    const result = composeCaption({ caption, facts: facts(), cta: CTA });

    expect(result.final).toBe(`${caption}\n${CTA}\n#LM02`);
    expect(result.additions).toEqual([CTA, "#LM02"]);
    expect(result.checks.some((c) => c.code === "REFERENCE_MISSING")).toBe(true);
  });

  it("leaves a caption alone when the reference and the CTA are present", () => {
    const caption = `Restock day.\n${CTA}\n#LM02`;
    const result = composeCaption({ caption, facts: facts(), cta: CTA });

    expect(result.final).toBe(caption);
    expect(result.additions).toEqual([]);
    expect(result.checks.some((c) => c.code === "REFERENCE_PRESENT" && c.level === "ok")).toBe(
      true
    );
    expect(result.checks.some((c) => c.code === "CTA_PRESENT" && c.level === "ok")).toBe(
      true
    );
  });

  it("errors with OTHER_REFERENCE when a different reference is in the caption", () => {
    const caption = "Two releases this week.\n#ABC001";
    const result = composeCaption({ caption, facts: facts(), cta: CTA });

    const other = result.checks.find((c) => c.code === "OTHER_REFERENCE");
    expect(other?.level).toBe("error");
    expect(other?.message).toContain("two messages");
    // The product hashtag must NOT be added: two references send two messages.
    expect(result.additions).not.toContain("#LM02");
    expect(result.final).toBe(`${caption}\n${CTA}`);
  });

  it("recognises the CTA case-insensitively on any line", () => {
    const caption = "Back in stock.\ncomment to get the link!";
    const result = composeCaption({ caption, facts: facts(), cta: CTA });

    expect(result.additions).toEqual(["#LM02"]);
    expect(result.final).toBe(`${caption}\n#LM02`);
    expect(result.checks.some((c) => c.code === "CTA_PRESENT")).toBe(true);
  });

  it("warns about the €220 price on the LM-02 caption sentence", () => {
    const caption =
      "Fighting the Discogs Sharks — sold for more than €220 on Discogs, now back on the shop.";
    const result = composeCaption({ caption, facts: facts(), cta: CTA });

    expect(result.checks.some((c) => c.code === "PRICE_IN_CAPTION" && c.level === "warn")).toBe(
      true
    );
  });

  it("warns about a URL, more than 5 hashtags and an over-long caption", () => {
    const long = "x".repeat(2300);
    const caption = `Shop at https://yoyaku.io ${Array.from(
      { length: 7 },
      (_, i) => `#tag${i}`
    ).join(" ")}`;
    const result = composeCaption({ caption, facts: facts(), cta: CTA });

    expect(result.checks.some((c) => c.code === "URL_IN_CAPTION")).toBe(true);
    expect(result.checks.some((c) => c.code === "TOO_MANY_HASHTAGS")).toBe(true);
    expect(
      composeCaption({ caption: long, facts: facts(), cta: CTA }).checks.some(
        (c) => c.code === "CAPTION_TOO_LONG"
      )
    ).toBe(true);
  });

  it("adds nothing for the hashtag when the post is already published", () => {
    const result = composeCaption({
      facts: facts(),
      cta: CTA,
      alreadyPublished: true,
    });

    expect(result.final).toBeNull();
    expect(result.additions).toEqual([]);
    expect(result.checks).toEqual([]);
  });

  it("keeps pasted-caption warnings but skips the hashtag addition for a published post", () => {
    const caption = "Fighting the Discogs Sharks, sold for more than €220 there.";
    const result = composeCaption({
      caption,
      facts: facts(),
      cta: CTA,
      alreadyPublished: true,
    });

    expect(result.additions).toEqual([CTA]);
    expect(result.final).toBe(`${caption}\n${CTA}`);
    expect(result.checks.some((c) => c.code === "PRICE_IN_CAPTION")).toBe(true);
    expect(result.checks.some((c) => c.code === "REFERENCE_MISSING")).toBe(false);
  });
});
