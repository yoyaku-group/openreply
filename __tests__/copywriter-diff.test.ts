import { describe, expect, it } from "vitest";
import { isWordDiffEmpty, wordDiff } from "@/lib/copywriter/diff";

describe("wordDiff", () => {
  it("returns a single equal token for identical texts", () => {
    const tokens = wordDiff("Grab your copy now", "Grab your copy now");
    expect(tokens).toEqual([{ op: "equal", value: "Grab your copy now" }]);
  });

  it("marks changed words as remove + add", () => {
    const tokens = wordDiff("Grab your copy now", "Grab your record now");
    expect(tokens).toEqual([
      { op: "equal", value: "Grab your" },
      { op: "remove", value: "copy" },
      { op: "add", value: "record" },
      { op: "equal", value: "now" },
    ]);
  });

  it("shows pure additions", () => {
    const tokens = wordDiff("Likemind 02", "Likemind 02 reissue");
    expect(tokens).toEqual([
      { op: "equal", value: "Likemind 02" },
      { op: "add", value: "reissue" },
    ]);
  });

  it("shows pure removals", () => {
    const tokens = wordDiff("back in stock at the shop", "back in stock");
    expect(tokens).toEqual([
      { op: "equal", value: "back in stock" },
      { op: "remove", value: "at the shop" },
    ]);
  });

  it("merges contiguous same-op tokens", () => {
    const tokens = wordDiff("a b c", "x y z");
    expect(tokens).toEqual([
      { op: "remove", value: "a b c" },
      { op: "add", value: "x y z" },
    ]);
  });

  it("handles empty sides", () => {
    expect(wordDiff("", "new text")).toEqual([{ op: "add", value: "new text" }]);
    expect(wordDiff("old text", "")).toEqual([{ op: "remove", value: "old text" }]);
    expect(wordDiff("", "")).toEqual([]);
  });

  it("keeps the shared middle on a rewrite around it", () => {
    const tokens = wordDiff(
      "Fighting the Discogs Sharks; Blueprint presents",
      "Fighting the Discogs Sharks; Blueprint ARchives presents a reissue"
    );
    const firstEqual = tokens.find((token) => token.op === "equal");
    expect(firstEqual?.value).toContain("Fighting the Discogs Sharks");
    expect(tokens.some((t) => t.op === "add" && t.value.includes("ARchives"))).toBe(true);
    expect(tokens.some((t) => t.op === "add" && t.value.includes("reissue"))).toBe(true);
  });

  it("isWordDiffEmpty reports unchanged texts and detects edits", () => {
    expect(isWordDiffEmpty("same words", "same words")).toBe(true);
    expect(isWordDiffEmpty("same words", "same wording")).toBe(false);
  });
});
