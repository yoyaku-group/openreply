import { describe, expect, it } from "vitest";
import {
  defaultMatcher,
  matcherFromKeywords,
  nextMatcher,
} from "@/lib/automations/match-defaults";

describe("comment matcher defaults", () => {
  it("starts a new comment campaign on any word", () => {
    expect(defaultMatcher("COMMENT")).toEqual({
      matchMode: "any",
      keywordText: "",
    });
  });

  it("keeps an inbound DM campaign on a specific word", () => {
    expect(defaultMatcher("INBOUND_DM")).toEqual({
      matchMode: "specific",
      keywordText: "",
    });
  });

  it("leaves the matcher alone when a trigger scope is selected", () => {
    const stored = { matchMode: "specific" as const, keywordText: "LINK" };
    // The catalogue scope used to force specific + LINK. It must not.
    expect(
      nextMatcher(stored, { kind: "triggerScope", scope: "catalogue" }, "new")
    ).toBe(stored);
    expect(
      nextMatcher(stored, { kind: "triggerScope", scope: "specific" }, "new")
    ).toBe(stored);
  });

  it("applies the create defaults when a new campaign switches trigger type", () => {
    const started = defaultMatcher("COMMENT");
    expect(
      nextMatcher(
        started,
        { kind: "triggerType", triggerType: "INBOUND_DM", from: "COMMENT" },
        "new"
      )
    ).toEqual({ matchMode: "specific", keywordText: "" });
    expect(
      nextMatcher(
        { matchMode: "specific", keywordText: "MB059" },
        { kind: "triggerType", triggerType: "COMMENT", from: "INBOUND_DM" },
        "new"
      )
    ).toEqual({ matchMode: "any", keywordText: "" });
  });

  it("keeps a typed word when the already selected trigger type is clicked again", () => {
    // The radios run their click handler even when already checked, so a
    // second click on the current trigger type must not reset the matcher.
    const typed = { matchMode: "specific" as const, keywordText: "MB059" };
    expect(
      nextMatcher(
        typed,
        { kind: "triggerType", triggerType: "COMMENT", from: "COMMENT" },
        "new"
      )
    ).toBe(typed);
    expect(
      nextMatcher(
        typed,
        { kind: "triggerType", triggerType: "INBOUND_DM", from: "INBOUND_DM" },
        "new"
      )
    ).toBe(typed);
    // And the untouched defaults are returned unchanged too.
    const started = defaultMatcher("COMMENT");
    expect(
      nextMatcher(
        started,
        { kind: "triggerType", triggerType: "COMMENT", from: "COMMENT" },
        "new"
      )
    ).toBe(started);
  });

  it("keeps the stored values when an existing campaign switches trigger type", () => {
    const stored = { matchMode: "specific" as const, keywordText: "MB059" };
    expect(
      nextMatcher(
        stored,
        { kind: "triggerType", triggerType: "COMMENT", from: "INBOUND_DM" },
        "edit"
      )
    ).toBe(stored);
  });

  it("reads an empty CSV keyword column as any comment", () => {
    expect(matcherFromKeywords([])).toEqual({
      matchMode: "any",
      keywordText: "",
    });
    expect(matcherFromKeywords(["", "  "])).toEqual({
      matchMode: "any",
      keywordText: "",
    });
  });

  it("keeps a filled CSV keyword column on a specific word", () => {
    expect(matcherFromKeywords(["LINK", "SHOP"])).toEqual({
      matchMode: "specific",
      keywordText: "LINK, SHOP",
    });
  });
});
