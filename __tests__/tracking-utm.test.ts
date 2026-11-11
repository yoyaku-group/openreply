import { describe, expect, it } from "vitest";
import { withDmUtm } from "@/lib/tracking/utm";

describe("withDmUtm", () => {
  it("adds the DM UTM parameters to a bare destination", () => {
    expect(withDmUtm("https://yoyaku.io/release/lm02/", "LM02")).toBe(
      "https://yoyaku.io/release/lm02/?utm_source=instagram&utm_medium=dm&utm_campaign=lm02",
    );
  });

  it("slugs the campaign: lower-case, runs of other characters become one dash", () => {
    const url = withDmUtm("https://yoyaku.io/barcelona/#signup", "Barcelona Opening Night");
    const campaign = new URL(url).searchParams.get("utm_campaign");
    expect(campaign).toBe("barcelona-opening-night");
    expect(url).toContain("#signup");
  });

  it("keeps the existing query and hash", () => {
    const url = withDmUtm("https://yoyaku.io/a/?foo=1&bar=2#section", "LM02");
    const parsed = new URL(url);
    expect(parsed.searchParams.get("foo")).toBe("1");
    expect(parsed.searchParams.get("bar")).toBe("2");
    expect(parsed.hash).toBe("#section");
    expect(parsed.searchParams.get("utm_source")).toBe("instagram");
    expect(parsed.searchParams.get("utm_medium")).toBe("dm");
    expect(parsed.searchParams.get("utm_campaign")).toBe("lm02");
  });

  it("never overwrites a parameter the URL already carries", () => {
    const url = withDmUtm(
      "https://yoyaku.io/a/?utm_source=instagram&utm_campaign=custom-camp",
      "LM02",
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.get("utm_source")).toBe("instagram");
    expect(parsed.searchParams.get("utm_campaign")).toBe("custom-camp");
    expect(parsed.searchParams.get("utm_medium")).toBe("dm");
  });

  it("returns an unparsable URL unchanged", () => {
    expect(withDmUtm("not a url", "LM02")).toBe("not a url");
    expect(withDmUtm("/relative/path", "LM02")).toBe("/relative/path");
  });

  it("omits utm_campaign when the campaign slugs to nothing", () => {
    const url = withDmUtm("https://yoyaku.io/a/", "---");
    const parsed = new URL(url);
    expect(parsed.searchParams.get("utm_source")).toBe("instagram");
    expect(parsed.searchParams.get("utm_medium")).toBe("dm");
    expect(parsed.searchParams.has("utm_campaign")).toBe(false);
  });

  it("is idempotent", () => {
    const once = withDmUtm("https://yoyaku.io/a/", "LM02");
    expect(withDmUtm(once, "LM02")).toBe(once);
  });
});
