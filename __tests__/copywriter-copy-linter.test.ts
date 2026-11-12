import { describe, expect, it } from "vitest";
import { lintCampaignCopy, lintGeneratedCopy } from "@/lib/copy/copy-linter";
import { copyEditDistance, levenshtein } from "@/lib/copywriter/edit-distance";
import type { CampaignCopy } from "@/lib/copy/yoyaku-patterns";
import type { ReleaseFacts } from "@/lib/copy/release-facts";

const FACTS: ReleaseFacts = {
  eventType: "restock",
  artist: "Nuron & Fugue",
  title: "Likemind 02",
  catno: "LM-02",
  label: "Blueprint ARchives",
  url: "https://yoyaku.io/release/nuro-fugue-nuron-likemind-02-lm-02/",
};

function copy(overrides: Partial<CampaignCopy> = {}): CampaignCopy {
  return {
    name: "LM-02 Restock link",
    goal: "Restock link",
    openingDmMessage: "Nuron & Fugue, Likemind 02 is back in stock.",
    openingDmButtonLabel: "Send the link",
    dmMessage: "Here you go:",
    linkButtonLabel: "LM-02",
    trackedDestinationUrl: FACTS.url,
    ...overrides,
  };
}

describe("lintCampaignCopy sourceText option", () => {
  it("refuses Discogs when no source text is given (previous behaviour)", () => {
    const result = lintCampaignCopy(
      copy({ dmMessage: "Here you go — Discogs does not have this." }),
      FACTS
    );
    // Without the option the invented-noun rule fires exactly as before.
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: "invented-noun" }),
      ])
    );
  });

  it("allows a proper noun that appears verbatim in the caption", () => {
    const result = lintCampaignCopy(
      copy({
        openingDmMessage: "Fighting the Discogs Sharks: Likemind 02 is back.",
      }),
      FACTS,
      {
        sourceText:
          "Fighting the Discogs Sharks. Blueprint ARchives presents a reissue of Likemind 02.",
      }
    );
    expect(result.ok).toBe(true);
  });

  it("still refuses a proper noun absent from both the facts and the source", () => {
    const result = lintCampaignCopy(
      copy({ openingDmMessage: "Waveform Collective, Likemind 02 is back." }),
      FACTS,
      { sourceText: "Blueprint ARchives presents a reissue of Likemind 02." }
    );
    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: "invented-noun" }),
      ])
    );
  });

  it("never relaxes emoji, dashes or length limits, whatever the source", () => {
    const result = lintCampaignCopy(
      copy({
        openingDmMessage:
          "Fighting the Discogs Sharks — grab it 🔥🔥 this is a very long message crafted only to exceed the Meta body limit of six hundred and forty characters for testing purposes, so let me keep typing until the counter blows well past the hard limit, thank you very much, this filler exists purely to trip the meta-body-limit rule in the linter, nothing else at all, and it keeps going a little further just to be safe about the six hundred and forty character budget of the Meta button template body which is the limit we are exercising here, with another whole sentence added on top to push the counter comfortably past the line, and yet one more sentence after that one because the first padding attempt landed just under the limit and the test needs to be clearly, unambiguously, definitively above six hundred and forty characters in total length.",
      }),
      FACTS,
      { sourceText: "Fighting the Discogs Sharks — grab it 🔥🔥. Meta counts this body limit." }
    );
    const rules = result.violations.map((v) => v.rule);
    expect(rules).toContain("no-dashes");
    expect(rules).toContain("no-emoji");
    expect(rules).toContain("meta-body-limit");
    expect(rules).not.toContain("invented-noun");
  });
});

describe("lintGeneratedCopy (AI output gate)", () => {
  it("refuses a price even when it appears verbatim in the caption", () => {
    const result = lintGeneratedCopy(
      copy({ dmMessage: "Here you go: 35 EUR, link below." }),
      FACTS,
      { sourceText: "35 EUR only, in the shop now." }
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ rule: "no-price" })])
    );
  });

  it("refuses a price or an AI mention inside a button label", () => {
    const priced = lintGeneratedCopy(copy({ linkButtonLabel: "Buy 25€" }), FACTS);
    expect(priced.violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ rule: "no-price" })])
    );
    const bot = lintGeneratedCopy(
      copy({ openingDmButtonLabel: "Ask the bot" }),
      FACTS
    );
    expect(bot.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: "no-ai-mention" }),
      ])
    );
  });

  it("refuses a URL in the AI copy", () => {
    const result = lintGeneratedCopy(
      copy({ dmMessage: "Here you go: https://yoyaku.io/release/x/" }),
      FACTS
    );
    expect(result.violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ rule: "no-url" })])
    );
  });

  it("refuses mentions of AI, bots or automation", () => {
    for (const text of [
      "Our AI picked this for you:",
      "A bot will answer:",
      "This is automated:",
      "Artificial intelligence says hi:",
    ]) {
      const result = lintGeneratedCopy(copy({ dmMessage: text }), FACTS);
      expect(result.violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ rule: "no-ai-mention" }),
        ])
      );
    }
  });

  it("passes clean house-style copy", () => {
    const result = lintGeneratedCopy(
      copy({
        openingDmMessage:
          "Nuron & Fugue, Likemind 02 is back in stock on Blueprint ARchives.",
        dmMessage: "Here you go:",
      }),
      FACTS,
      { sourceText: "Discogs sharks" }
    );
    expect(result.ok).toBe(true);
  });
});

describe("invented-noun: sentence starts and possessives (LM-02 smoke 2026-11-12)", () => {
  // The first real production generation for LM-02: the copy was faithful,
  // yet the linter refused it for "Saw", "Want", "This" and "Nuron's".
  const SOURCE =
    "Four pieces of melodic, abstract techno from the 1994 UK split: Mirage and In Motion by Nuron, Contrapoint and Interlagos by Fugue.";
  const inventedNoun = (violations: { rule: string; detail: string }[]) =>
    violations.filter((v) => v.rule === "invented-noun");

  it("does not read a capitalized sentence start as a proper noun", () => {
    const result = lintCampaignCopy(
      copy({
        openingDmMessage:
          "Saw your comment on the post. Likemind 02 is back in stock. Want us to send you the link?",
        dmMessage: "This one tends to move fast. Here you go:",
      }),
      FACTS,
      { sourceText: SOURCE }
    );
    expect(result.violations).toEqual([]);
  });

  it("keeps no-hey-opening without double-reporting Hey as a noun", () => {
    const result = lintCampaignCopy(
      copy({ openingDmMessage: "Hey! Saw your comment. Likemind 02 is back." }),
      FACTS,
      { sourceText: SOURCE }
    );
    expect(result.violations.map((v) => v.rule)).toEqual(["no-hey-opening"]);
  });

  it("accepts the possessive of a fact or source name", () => {
    const result = lintCampaignCopy(
      copy({
        dmMessage:
          "Here you go. Nuron's Mirage and In Motion paired with Fugue's Contrapoint and Interlagos.",
      }),
      FACTS,
      { sourceText: SOURCE }
    );
    expect(inventedNoun(result.violations)).toEqual([]);
  });

  it("still refuses an invented name at the start of a sentence", () => {
    const result = lintCampaignCopy(
      copy({ openingDmMessage: "Burial is back. Likemind 02 is in stock." }),
      FACTS,
      { sourceText: SOURCE }
    );
    expect(inventedNoun(result.violations)).toHaveLength(1);
    expect(inventedNoun(result.violations)[0].detail).toContain("Burial");
  });

  it("still refuses an invented possessive", () => {
    const result = lintCampaignCopy(
      copy({ dmMessage: "Here you go, Burial's favourite record." }),
      FACTS,
      { sourceText: SOURCE }
    );
    expect(inventedNoun(result.violations)[0]?.detail).toContain("Burial's");
  });

  it("applies the starter list at sentence start only", () => {
    const result = lintCampaignCopy(
      copy({ openingDmMessage: "Likemind 02 is back for This crowd." }),
      FACTS,
      { sourceText: SOURCE }
    );
    expect(inventedNoun(result.violations)[0]?.detail).toContain("This");
  });

  it("keeps the rhetorical-hook rule on AI copy", () => {
    const result = lintGeneratedCopy(
      copy({ dmMessage: "Here you go. The reissue is back in stock, ready to spin." }),
      FACTS,
      { sourceText: SOURCE }
    );
    expect(result.violations.map((v) => v.rule)).toContain("rhetorical-hook");
  });
});

describe("copyEditDistance", () => {
  it("computes character-level Levenshtein", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("same", "same")).toBe(0);
  });

  it("sums the distance across the four fields", () => {
    expect(
      copyEditDistance(
        {
          openingDm: "abc",
          openingButton: "x",
          revealDm: "same",
          linkButton: "y",
        },
        {
          openingDm: "abd",
          openingButton: "x",
          revealDm: "same",
          linkButton: "y",
        }
      )
    ).toBe(1);
  });

  it("treats a null opening field as empty text", () => {
    expect(
      copyEditDistance(
        { openingDm: null, openingButton: null, revealDm: "Here", linkButton: "y" },
        { openingDm: "", openingButton: "", revealDm: "Here", linkButton: "y" }
      )
    ).toBe(0);
  });
});
