import { describe, expect, it, vi } from "vitest";
import {
  CATNO_TAG_MAX_LENGTH,
  captionHasCatnoTag,
  displayCatnoTag,
  extractCaptionCatnoTags,
  findPendingCatalogueConflict,
  findUnboundCalendarConflict,
  normalizeCatnoTag,
  parseCatnoTag,
} from "@/lib/automations/catalogue";

describe("normalizeCatnoTag", () => {
  it("strips separators and upper-cases", () => {
    expect(normalizeCatnoTag("LM-02")).toBe("LM02");
    expect(normalizeCatnoTag("lm02")).toBe("LM02");
    expect(normalizeCatnoTag("#LM_02")).toBe("LM02");
    expect(normalizeCatnoTag("BPA 001")).toBe("BPA001");
    expect(normalizeCatnoTag("  #abc001  ")).toBe("ABC001");
    expect(normalizeCatnoTag("##lm-02")).toBe("LM02");
  });

  it("maps nothing to null", () => {
    expect(normalizeCatnoTag(null)).toBeNull();
    expect(normalizeCatnoTag(undefined)).toBeNull();
    expect(normalizeCatnoTag("")).toBeNull();
    expect(normalizeCatnoTag("---")).toBeNull();
  });
});

describe("parseCatnoTag", () => {
  it("accepts separators, casing and one leading #", () => {
    expect(parseCatnoTag("LM-02")).toEqual({ ok: true, value: "LM02" });
    expect(parseCatnoTag("lm02")).toEqual({ ok: true, value: "LM02" });
    expect(parseCatnoTag("#LM_02")).toEqual({ ok: true, value: "LM02" });
    expect(parseCatnoTag("BPA 001")).toEqual({ ok: true, value: "BPA001" });
    expect(parseCatnoTag("#ABC001")).toEqual({ ok: true, value: "ABC001" });
    expect(parseCatnoTag("TO001")).toEqual({ ok: true, value: "TO001" });
  });

  it("rejects a reference without a digit", () => {
    for (const value of ["LM", "#LM", "VINYL", "#TECHNO"]) {
      const parsed = parseCatnoTag(value);
      expect(parsed.ok, value).toBe(false);
    }
    // The digit rule is spelled out to the operator for word-shaped input.
    for (const value of ["VINYL", "#TECHNO"]) {
      const parsed = parseCatnoTag(value);
      if (!parsed.ok) {
        expect(parsed.message).toMatch(/at least one digit/);
      }
    }
  });

  it("rejects empty input", () => {
    for (const value of ["", "   ", "#"]) {
      const parsed = parseCatnoTag(value);
      expect(parsed.ok, JSON.stringify(value)).toBe(false);
    }
  });

  it("rejects a reference shorter than 3 characters", () => {
    const parsed = parseCatnoTag("A1");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toMatch(/at least 3 characters/);
  });

  it("rejects a normalized value over the length limit", () => {
    const overLong = `B${"C".repeat(CATNO_TAG_MAX_LENGTH)}9`;
    expect(overLong.length).toBe(CATNO_TAG_MAX_LENGTH + 2);
    const parsed = parseCatnoTag(overLong);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toMatch(/at most 50 characters/);
  });

  it("rejects characters outside the accepted set", () => {
    const parsed = parseCatnoTag("#LM.02");
    expect(parsed.ok).toBe(false);
  });
});

describe("extractCaptionCatnoTags", () => {
  it("extracts and normalizes the references a caption carries", () => {
    expect(extractCaptionCatnoTags("Out now #LM-02 and #bpa_001")).toEqual([
      "LM02",
      "BPA001",
    ]);
  });

  it("de-duplicates in order", () => {
    expect(extractCaptionCatnoTags("#LM02 then #lm02 then #LM_02")).toEqual([
      "LM02",
    ]);
  });

  it("drops tokens that are not references", () => {
    expect(extractCaptionCatnoTags("#LM #VINYL #LM02X #TO001")).toEqual([
      "LM02X",
      "TO001",
    ]);
  });

  it("returns both references a caption carries", () => {
    expect(extractCaptionCatnoTags("Two releases: #LM-02 + #BPA001")).toEqual([
      "LM02",
      "BPA001",
    ]);
  });
});

describe("captionHasCatnoTag (whole-token equality)", () => {
  it("matches every accepted caption form against the canonical tag", () => {
    expect(captionHasCatnoTag("Out now #LM-02", "LM02")).toBe(true);
    expect(captionHasCatnoTag("Out now #lm02", "LM02")).toBe(true);
    expect(captionHasCatnoTag("Out now #LM02", "LM02")).toBe(true);
    expect(captionHasCatnoTag("Out now #LM_02", "LM02")).toBe(true);
  });

  it("matches the canonical tag against a legacy separator tag", () => {
    expect(captionHasCatnoTag("Out now #LM-02", "LM-02")).toBe(true);
    expect(captionHasCatnoTag("Out now #LM02", "LM-02")).toBe(true);
    expect(captionHasCatnoTag("Out now #lm02", "#lm-02")).toBe(true);
  });

  it("never matches a different or partial token", () => {
    expect(captionHasCatnoTag("Out now #LM02X", "LM02")).toBe(false);
    expect(captionHasCatnoTag("Out now #LM", "LM02")).toBe(false);
    expect(captionHasCatnoTag("LM02 without a hash", "LM02")).toBe(false);
    expect(captionHasCatnoTag("#TO0011 out now", "TO001")).toBe(false);
    expect(captionHasCatnoTag("#ABC001_EXTRA", "ABC001")).toBe(false);
    expect(captionHasCatnoTag("#ABC001 EXTRA", "ABC001")).toBe(true);
  });

  it("never matches a tag without a digit", () => {
    expect(captionHasCatnoTag("#LM is not a reference", "LM")).toBe(false);
    expect(captionHasCatnoTag("#VINYL is not a reference", "VINYL")).toBe(false);
  });
});

describe("displayCatnoTag", () => {
  it("formats the canonical hashtag for display and copy", () => {
    expect(displayCatnoTag("LM-02")).toBe("#LM02");
    expect(displayCatnoTag("lm02")).toBe("#LM02");
    expect(displayCatnoTag(null)).toBeNull();
  });
});

describe("conflict checks survive legacy separator rows", () => {
  const legacyRow = {
    id: "legacy_1",
    name: "LM-02 waiting",
    source: "MANUAL",
    lifecycle: "ACTIVE",
    isActive: true,
  };

  function clientWith(queryResult: unknown[]) {
    // Tagged-template calls land as (template, ...params) on $queryRaw.
    const queryRaw = vi.fn(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async (template: TemplateStringsArray, ...params: unknown[]) =>
        queryResult,
    );
    const client = {
      $queryRaw: queryRaw,
    } as unknown as Parameters<typeof findPendingCatalogueConflict>[1];
    return { client, queryRaw };
  }

  it("detects a legacy LM-02 row as a pending conflict for LM02", async () => {
    const { client, queryRaw } = clientWith([legacyRow]);
    const conflict = await findPendingCatalogueConflict(
      { instagramAccountId: "account_1", catnoTag: "LM02" },
      client,
    );
    expect(conflict).toEqual(legacyRow);
    // The comparison runs in Postgres on the canonical form of the STORED
    // value, so a row still holding `LM-02` is found by this same query.
    const [template, ...params] = queryRaw.mock.calls[0];
    expect(template.join("?")).toContain(
      `upper(regexp_replace("catnoTag", '[^A-Za-z0-9]', '', 'g')) = ?`,
    );
    expect(params).toContain("LM02");
    expect(params).toContain("account_1");
  });

  it("passes the self-exclusion to the query", async () => {
    const { client, queryRaw } = clientWith([]);
    await findPendingCatalogueConflict(
      {
        instagramAccountId: "account_1",
        catnoTag: "LM02",
        excludeAutomationId: "automation_self",
      },
      client,
    );
    expect(queryRaw.mock.calls[0].slice(1)).toContain("automation_self");
  });

  it("finds a legacy calendar row for the same reference", async () => {
    const calendarRow = { ...legacyRow, source: "CALENDAR", lifecycle: "READY" };
    const { client, queryRaw } = clientWith([calendarRow]);
    const conflict = await findUnboundCalendarConflict(
      {
        instagramAccountId: "account_1",
        catnoTag: "LM-02",
        mediaId: "media_9",
        excludeAutomationId: "automation_self",
      },
      client,
    );
    expect(conflict).toEqual(calendarRow);
    const [template, ...params] = queryRaw.mock.calls[0];
    const sql = template.join("?");
    expect(sql).toContain(`"source" = 'CALENDAR'`);
    expect(sql).toContain(`"pendingNextReel" = false`);
    expect(params).toContain("LM02");
    expect(params).toContain("media_9");
    expect(params).toContain("automation_self");
  });

  it("finds an unbound calendar row without a candidate media", async () => {
    const { client, queryRaw } = clientWith([legacyRow]);
    await findUnboundCalendarConflict(
      { instagramAccountId: "account_1", catnoTag: "LM02" },
      client,
    );
    const [template, ...params] = queryRaw.mock.calls[0];
    expect(template.join("?")).toContain(`"postId" IS NULL`);
    expect(params).toContain(null);
  });

  it("answers no conflict for a reference that normalizes to nothing", async () => {
    const { client, queryRaw } = clientWith([legacyRow]);
    const conflict = await findPendingCatalogueConflict(
      { instagramAccountId: "account_1", catnoTag: "---" },
      client,
    );
    expect(conflict).toBeNull();
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
