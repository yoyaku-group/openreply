import { describe, expect, it } from "vitest";
import {
  matchInboundDmAutomations,
  normalizeInboundDmKeyword,
  normalizeInboundDmKeywords,
} from "@/lib/automations/inbound-dm";

describe("exact inbound DM keyword matching", () => {
  it.each([
    ["MB059", "mb059"],
    [" mb059 ", "mb059"],
    ["#MB059", "mb059"],
    ["MB059.", "mb059"],
    ["mb059!", "mb059"],
    ["\uFF2D\uFF22\uFF10\uFF15\uFF19?", "mb059"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeInboundDmKeyword(input)).toBe(expected);
  });

  it.each([
    "",
    "MB059 please",
    "please send MB059",
    "##MB059",
    "MB059!!",
    "MB059 reaction",
  ])("rejects non-command message %s", (input) => {
    expect(normalizeInboundDmKeyword(input)).toBeNull();
  });

  it("rejects attachments even with an exact keyword", () => {
    expect(normalizeInboundDmKeyword("MB059", true)).toBeNull();
  });

  it("detects normalized duplicates", () => {
    expect(normalizeInboundDmKeywords(["MB059", "#mb059."])).toEqual({
      normalized: ["mb059"],
      invalid: [],
      duplicates: ["#mb059."],
    });
  });

  it("returns every match so callers can fail closed", () => {
    const matches = matchInboundDmAutomations(
      [
        { id: "a1", keywords: ["MB059"] },
        { id: "a2", keywords: ["#mb059"] },
        { id: "a3", keywords: ["OTHER"] },
      ],
      "MB059?"
    );
    expect(matches.map((match) => match.automation.id)).toEqual(["a1", "a2"]);
  });
});
