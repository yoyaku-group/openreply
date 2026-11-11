import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockTx } = vi.hoisted(() => {
  const mockTx = {
    $queryRaw: vi.fn(),
    copyGeneration: { updateMany: vi.fn() },
    copywriterPrompt: { findFirst: vi.fn(), create: vi.fn() },
  };
  const mockPrisma = {
    $transaction: vi.fn(async (input: unknown) =>
      Array.isArray(input)
        ? Promise.all(input)
        : (input as (tx: typeof mockTx) => unknown)(mockTx)
    ),
    $queryRaw: vi.fn(),
    copyGeneration: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
    copywriterPrompt: {
      findFirst: vi.fn(),
      create: vi.fn(),
      groupBy: vi.fn(),
    },
    automation: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  };
  return { mockPrisma, mockTx };
});

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import {
  applyGenerationToAutomation,
  claimCopyItems,
  CopywriterError,
  COPY_SCHEMA,
  enqueueGeneration,
  extractFirstJsonObject,
  FAILURE_CODES,
  getGenerationStatus,
  purgeExpiredCopyGenerations,
  recordFinalCopy,
  renderPrompt,
  repairAppendix,
  storedCopyFromCampaignCopy,
  submitCopyFailure,
  submitCopyResult,
} from "@/lib/copywriter/service";
import type { ProductFacts } from "@/lib/assistant/resolve-product";

const FACTS: ProductFacts = {
  productId: 746990,
  sku: "LM-02",
  catnoTag: "LM02",
  hashtag: "#LM02",
  title: "Likemind 02",
  artists: ["Nuron", "Fugue"],
  label: "Blueprint ARchives",
  permalink: "https://yoyaku.io/release/nuro-fugue-nuron-likemind-02-lm-02/",
  imageUrl: null,
  description:
    "Blueprint ARchives presents a reissue of Likemind 02, the 1994 UK split release by Nuron and Fugue.",
  state: "restock",
  missing: [],
};

const STANDARD_COPY = {
  openingDm: "Nuron & Fugue, Likemind 02 is back in stock.",
  openingButton: "Send the link",
  revealDm: "Here you go:",
  linkButton: "LM-02",
};

const VALID_OUTPUT = JSON.stringify({
  openingDm: "Nuron & Fugue, Likemind 02 is back in stock.",
  openingButton: "Send the link",
  revealDm: "Here you go: Likemind 02, the 1994 split on Blueprint ARchives.",
  linkButton: "LM-02",
});

function generationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "gen_1",
    workspaceId: "workspace_1",
    automationId: null,
    promptId: "prompt_1",
    promptVersion: 1,
    attempt: 1,
    status: "CLAIMED",
    leaseOwner: "worker-1",
    leaseExpiresAt: new Date(Date.now() + 30_000),
    input: { facts: FACTS, caption: null },
    renderedPrompt: "RENDERED PROMPT",
    output: null,
    lintErrors: null,
    tier: null,
    latencyMs: null,
    failureCode: null,
    standardCopy: STANDARD_COPY,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  // Leftover mockResolvedValueOnce rows from a previous test must never leak.
  mockPrisma.copyGeneration.findUnique.mockReset();
  mockPrisma.copyGeneration.findUnique.mockResolvedValue(null);
  mockTx.$queryRaw.mockResolvedValue([]);
  mockTx.copyGeneration.updateMany.mockResolvedValue({ count: 0 });
  mockTx.copywriterPrompt.findFirst.mockReset();
  mockTx.copywriterPrompt.findFirst.mockResolvedValue(null);
  mockTx.copywriterPrompt.create.mockReset();
  mockTx.copywriterPrompt.create.mockResolvedValue({ id: "prompt_new" });
  mockPrisma.copyGeneration.create.mockResolvedValue({ id: "gen_new" });
  mockPrisma.copyGeneration.update.mockResolvedValue({});
  mockPrisma.copyGeneration.findUnique.mockResolvedValue(null);
  mockPrisma.copyGeneration.findMany.mockResolvedValue([]);
  mockPrisma.copyGeneration.deleteMany.mockResolvedValue({ count: 0 });
  mockPrisma.copywriterPrompt.findFirst.mockResolvedValue({
    id: "prompt_1",
    workspaceId: "workspace_1",
    version: 1,
    model: "haiku",
    body: "FACTS:\n{{facts}}\n{{caption}}\nSTATE: {{state}}",
  });
  mockPrisma.automation.findUnique.mockResolvedValue(null);
  mockPrisma.automation.update.mockResolvedValue({});
});

describe("renderPrompt", () => {
  it("renders facts, description, state and keeps a 1200-character cap", () => {
    const promptBody = "FACTS:\n{{facts}}\nDESCRIPTION:\n{{description}}\nSTATE: {{state}}";
    const longDescription = "x".repeat(1400);
    const rendered = renderPrompt(
      promptBody,
      { ...FACTS, description: longDescription },
      null
    );
    expect(rendered).toContain('"sku": "LM-02"');
    expect(rendered).toContain('"state": "restock"');
    expect(rendered).toContain("Likemind 02");
    // Truncated to the cap, with the ellipsis marker.
    expect(rendered).not.toContain("x".repeat(1300));
    expect(rendered).toContain("…");
    expect(rendered).toContain("STATE: restock");
  });

  it("adds no CAPTION block when the caption is empty or missing", () => {
    const promptBody = "RULES ok\n{{caption}}\nSTATE: {{state}}";
    const without = renderPrompt(promptBody, FACTS, null);
    const empty = renderPrompt(promptBody, FACTS, "   ");
    expect(without).not.toContain("CAPTION");
    expect(empty).not.toContain("CAPTION");
    expect(empty).toBe(without);
  });

  it("renders the caption block with a truncation cap when given", () => {
    const promptBody = "{{caption}}";
    const longCaption = "y".repeat(1400);
    const rendered = renderPrompt(promptBody, FACTS, longCaption);
    expect(rendered).toContain("POST CAPTION");
    expect(rendered).not.toContain("y".repeat(1300));
    expect(rendered).toContain("…");
  });

  it("renders no examples block in v1", () => {
    const promptBody = "{{examples}}STATE: {{state}}";
    const rendered = renderPrompt(promptBody, FACTS, null);
    expect(rendered).toBe("STATE: restock");
  });
});

describe("enqueueGeneration", () => {
  it("returns null without touching the database when disabled", async () => {
    delete process.env.COPYWRITER_ENABLED;
    const id = await enqueueGeneration({
      workspaceId: "workspace_1",
      facts: FACTS,
      standardCopy: STANDARD_COPY,
    });
    expect(id).toBeNull();
    expect(mockPrisma.copywriterPrompt.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.copyGeneration.create).not.toHaveBeenCalled();
  });

  it("queues a row with the rendered prompt when enabled", async () => {
    process.env.COPYWRITER_ENABLED = "true";
    const id = await enqueueGeneration({
      workspaceId: "workspace_1",
      facts: FACTS,
      caption: "Fighting the Discogs Sharks",
      standardCopy: STANDARD_COPY,
    });
    expect(id).toBe("gen_new");
    expect(mockPrisma.copyGeneration.create).toHaveBeenCalledTimes(1);
    const data = mockPrisma.copyGeneration.create.mock.calls[0][0].data;
    expect(data.workspaceId).toBe("workspace_1");
    expect(data.promptId).toBe("prompt_1");
    expect(data.renderedPrompt).toContain("POST CAPTION");
    expect(data.renderedPrompt).toContain("Discogs");
    expect(data.input.caption).toBe("Fighting the Discogs Sharks");
    expect(data.standardCopy).toEqual(STANDARD_COPY);
  });

  it("seeds the v1 prompt from the markdown file on first use", async () => {
    process.env.COPYWRITER_ENABLED = "true";
    mockPrisma.copywriterPrompt.findFirst.mockResolvedValue(null);
    await enqueueGeneration({
      workspaceId: "workspace_1",
      facts: FACTS,
      standardCopy: STANDARD_COPY,
    });
    expect(mockTx.copywriterPrompt.findFirst).toHaveBeenCalledTimes(1);
    expect(mockTx.copywriterPrompt.create).toHaveBeenCalledTimes(1);
    const data = mockTx.copywriterPrompt.create.mock.calls[0][0].data;
    expect(data.version).toBe(1);
    expect(data.isActive).toBe(true);
    expect(data.body).toContain('"openingDm"');
  });

  it("returns null (standard copy stays) when the queue write fails", async () => {
    process.env.COPYWRITER_ENABLED = "true";
    mockPrisma.copyGeneration.create.mockRejectedValue(new Error("db down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const id = await enqueueGeneration({
      workspaceId: "workspace_1",
      facts: FACTS,
      standardCopy: STANDARD_COPY,
    });
    expect(id).toBeNull();
    errorSpy.mockRestore();
  });
});

describe("extractFirstJsonObject", () => {
  it("finds the object inside prose", () => {
    const parsed = extractFirstJsonObject(
      'Sure! {"openingDm":"a"} hope that helps'
    );
    expect(parsed).toEqual({ openingDm: "a" });
  });

  it("keeps braces inside strings balanced", () => {
    const parsed = extractFirstJsonObject('{"revealDm":"a {curly} b"}');
    expect(parsed).toEqual({ revealDm: "a {curly} b" });
  });

  it("returns null for garbage", () => {
    expect(extractFirstJsonObject("no json here")).toBeNull();
    expect(extractFirstJsonObject('{"truncated": ')).toBeNull();
  });
});

describe("claimCopyItems", () => {
  it("clamps the requested limit to 5", async () => {
    await claimCopyItems("worker-1", 99);
    const [template, ...values] = mockTx.$queryRaw.mock.calls[0];
    expect(template.join("?")).toContain("LIMIT");
    expect(values).toContain(5);
  });

  it("leases rows with FOR UPDATE SKIP LOCKED and returns the worker contract", async () => {
    mockTx.$queryRaw.mockResolvedValue([{ id: "gen_1" }]);
    mockTx.copyGeneration.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.copyGeneration.findMany.mockResolvedValue([
      {
        id: "gen_1",
        renderedPrompt: "RENDERED",
        createdAt: new Date(),
        prompt: { model: "haiku" },
      },
    ]);

    const items = await claimCopyItems("worker-1", 5);
    expect(items).toEqual([
      {
        id: "gen_1",
        renderedPrompt: "RENDERED",
        jsonSchema: COPY_SCHEMA,
        model: "haiku",
        timeoutSec: 45,
      },
    ]);
    const sql = mockTx.$queryRaw.mock.calls[0][0].join("?");
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain("'PENDING'");
    const leaseData = mockTx.copyGeneration.updateMany.mock.calls[0][0].data;
    expect(leaseData.leaseOwner).toBe("worker-1");
    expect(leaseData.status).toBe("CLAIMED");
  });
});

describe("submitCopyResult", () => {
  it("marks DONE on valid JSON that passes the linter", async () => {
    mockPrisma.copyGeneration.findUnique.mockResolvedValue(generationRow());
    const result = await submitCopyResult("gen_1", "worker-1", {
      rawOutput: VALID_OUTPUT,
      tier: "claude",
      latencyMs: 900,
    });
    expect(result).toEqual({ status: "DONE" });
    const data = mockPrisma.copyGeneration.update.mock.calls[0][0].data;
    expect(data.status).toBe("DONE");
    expect(data.output).toMatchObject({ openingDm: expect.any(String) });
    expect(data.tier).toBe("claude");
    expect(data.latencyMs).toBe(900);
  });

  it("queues one repair attempt on invalid JSON (attempt 1)", async () => {
    mockPrisma.copyGeneration.findUnique.mockResolvedValue(generationRow());
    const result = await submitCopyResult("gen_1", "worker-1", {
      rawOutput: "I could not produce JSON today, sorry.",
      tier: "claude",
      latencyMs: 400,
    });
    expect(result).toEqual({ status: "REPAIRED" });
    const failedUpdate = mockPrisma.copyGeneration.update.mock.calls[0][0];
    const repairCreate = mockPrisma.copyGeneration.create.mock.calls[0][0];
    expect(failedUpdate.where).toEqual({ id: "gen_1" });
    expect(failedUpdate.data.failureCode).toBe(FAILURE_CODES.LINT_REPAIR_QUEUED);
    expect(failedUpdate.data.status).toBe("FAILED");
    expect(repairCreate.data.attempt).toBe(2);
    // No explicit status: the row lands as the PENDING column default.
    expect(repairCreate.data.status).toBeUndefined();
    expect(repairCreate.data.renderedPrompt).toContain("RENDERED PROMPT");
    expect(repairCreate.data.renderedPrompt).toContain("FIX THE PREVIOUS ANSWER");
    expect(repairCreate.data.renderedPrompt).toContain(
      "I could not produce JSON today"
    );
  });

  it("fails with LINT_FAILED when attempt 2 fails the linter", async () => {
    mockPrisma.copyGeneration.findUnique.mockResolvedValue(
      generationRow({ attempt: 2 })
    );
    const invented = JSON.stringify({
      openingDm: "Waveform Collective, Likemind 02 is back in stock.",
      openingButton: "Send the link",
      revealDm: "Here you go:",
      linkButton: "LM-02",
    });
    const result = await submitCopyResult("gen_1", "worker-1", {
      rawOutput: invented,
      tier: "claude",
      latencyMs: 800,
    });
    expect(result).toEqual({ status: "FAILED" });
    const data = mockPrisma.copyGeneration.update.mock.calls[0][0].data;
    expect(data.status).toBe("FAILED");
    expect(data.failureCode).toBe(FAILURE_CODES.LINT_FAILED);
    expect(data.lintErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: "invented-noun" }),
      ])
    );
  });

  it("allows a proper noun that appears verbatim in the description or caption", async () => {
    mockPrisma.copyGeneration.findUnique.mockResolvedValue(
      generationRow({
        input: {
          facts: FACTS,
          caption: "Fighting the Discogs Sharks — the LM02 story",
        },
      })
    );
    const withDiscogs = JSON.stringify({
      openingDm: "Fighting the Discogs Sharks: Likemind 02 is back.",
      openingButton: "Send the link",
      revealDm: "Here you go:",
      linkButton: "LM-02",
    });
    const result = await submitCopyResult("gen_1", "worker-1", {
      rawOutput: withDiscogs,
      tier: "claude",
      latencyMs: 500,
    });
    expect(result).toEqual({ status: "DONE" });
  });

  it("rejects a wrong lease owner without writing", async () => {
    mockPrisma.copyGeneration.findUnique.mockResolvedValue(generationRow());
    await expect(
      submitCopyResult("gen_1", "worker-2", {
        rawOutput: VALID_OUTPUT,
        tier: "claude",
        latencyMs: 100,
      })
    ).rejects.toMatchObject({ code: "INVALID_LEASE", status: 409 });
    expect(mockPrisma.copyGeneration.update).not.toHaveBeenCalled();
  });

  it("rejects an expired lease", async () => {
    mockPrisma.copyGeneration.findUnique.mockResolvedValue(
      generationRow({ leaseExpiresAt: new Date(Date.now() - 1000) })
    );
    await expect(
      submitCopyResult("gen_1", "worker-1", {
        rawOutput: VALID_OUTPUT,
        tier: "claude",
        latencyMs: 100,
      })
    ).rejects.toMatchObject({ code: "INVALID_LEASE" });
  });
});

describe("submitCopyFailure", () => {
  it("marks FAILED with a sanitized code and never retries", async () => {
    mockPrisma.copyGeneration.findUnique.mockResolvedValue(generationRow());
    await submitCopyFailure("gen_1", "worker-1", "CASCADE_FAILED");
    const data = mockPrisma.copyGeneration.update.mock.calls[0][0].data;
    expect(data.status).toBe("FAILED");
    expect(data.failureCode).toBe("CASCADE_FAILED");
  });

  it("rejects a wrong lease owner", async () => {
    mockPrisma.copyGeneration.findUnique.mockResolvedValue(generationRow());
    await expect(
      submitCopyFailure("gen_1", "worker-9", "CASCADE_FAILED")
    ).rejects.toMatchObject({ code: "INVALID_LEASE" });
  });
});

describe("applyGenerationToAutomation (release-sync guard)", () => {
  const output = {
    openingDm: "Nuron & Fugue, Likemind 02. The preorder is open on Blueprint ARchives.",
    openingButton: "Preorder LM-02",
    revealDm: "Here you go:",
    linkButton: "LM-02",
  };

  function rowWithAutomation(overrides: Record<string, unknown> = {}) {
    return generationRow({
      status: "DONE",
      automationId: "automation_1",
      output,
      ...overrides,
    });
  }

  it("applies the AI copy to an untouched inactive campaign and records appliedAt", async () => {
    mockPrisma.copyGeneration.findUnique.mockResolvedValue(rowWithAutomation());
    mockPrisma.automation.findUnique.mockResolvedValue({
      id: "automation_1",
      isActive: false,
      openingDmMessage: STANDARD_COPY.openingDm,
      openingDmButtonLabel: STANDARD_COPY.openingButton,
      dmMessage: STANDARD_COPY.revealDm,
      linkButtonLabel: STANDARD_COPY.linkButton,
    });

    const outcome = await applyGenerationToAutomation("gen_1");
    expect(outcome).toBe("applied");
    const automationData = mockPrisma.automation.update.mock.calls[0][0];
    expect(automationData.where).toEqual({ id: "automation_1" });
    // Exactly the four copy fields; the campaign is never activated and no
    // public reply or binding field is ever touched.
    expect(Object.keys(automationData.data).sort()).toEqual([
      "dmMessage",
      "linkButtonLabel",
      "openingDmButtonLabel",
      "openingDmMessage",
    ]);
    expect(automationData.data.isActive).toBeUndefined();
    expect(automationData.data.dmMessage).toBe(output.revealDm);
    expect(mockPrisma.copyGeneration.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "gen_1" },
        data: expect.objectContaining({ appliedAt: expect.any(Date) }),
      })
    );
  });

  it("skips an edited campaign without overwriting it", async () => {
    mockPrisma.copyGeneration.findUnique.mockResolvedValue(rowWithAutomation());
    mockPrisma.automation.findUnique.mockResolvedValue({
      id: "automation_1",
      isActive: false,
      // The team edited the reveal DM after creation.
      openingDmMessage: STANDARD_COPY.openingDm,
      openingDmButtonLabel: STANDARD_COPY.openingButton,
      dmMessage: "Hand-edited reveal text",
      linkButtonLabel: STANDARD_COPY.linkButton,
    });

    const outcome = await applyGenerationToAutomation("gen_1");
    expect(outcome).toBe("skipped_edited");
    expect(mockPrisma.automation.update).not.toHaveBeenCalled();
    expect(mockPrisma.copyGeneration.update).not.toHaveBeenCalled();
  });

  it("skips an active campaign without touching it", async () => {
    mockPrisma.copyGeneration.findUnique.mockResolvedValue(rowWithAutomation());
    mockPrisma.automation.findUnique.mockResolvedValue({
      id: "automation_1",
      isActive: true,
      openingDmMessage: STANDARD_COPY.openingDm,
      openingDmButtonLabel: STANDARD_COPY.openingButton,
      dmMessage: STANDARD_COPY.revealDm,
      linkButtonLabel: STANDARD_COPY.linkButton,
    });

    const outcome = await applyGenerationToAutomation("gen_1");
    expect(outcome).toBe("skipped_active");
    expect(mockPrisma.automation.update).not.toHaveBeenCalled();
  });

  it("skips when the automation is gone or the row has no output", async () => {
    mockPrisma.copyGeneration.findUnique.mockResolvedValue(
      rowWithAutomation({ output: null })
    );
    expect(await applyGenerationToAutomation("gen_1")).toBe("skipped_no_output");

    mockPrisma.copyGeneration.findUnique.mockResolvedValue(
      rowWithAutomation({ automationId: "automation_gone" })
    );
    mockPrisma.automation.findUnique.mockResolvedValue(null);
    expect(await applyGenerationToAutomation("gen_1")).toBe(
      "skipped_no_automation"
    );
  });
});

describe("session-side status and final copy", () => {
  it("returns the status for the owning workspace and null otherwise", async () => {
    mockPrisma.copyGeneration.findUnique.mockResolvedValue(
      generationRow({
        status: "DONE",
        output: {
          openingDm: "a",
          openingButton: "b",
          revealDm: "c",
          linkButton: "d",
        },
        tier: "claude",
      })
    );
    const own = await getGenerationStatus("gen_1", "workspace_1");
    expect(own).toMatchObject({
      status: "DONE",
      promptVersion: 1,
      tier: "claude",
    });
    expect(own?.copy).toEqual({
      openingDm: "a",
      openingButton: "b",
      revealDm: "c",
      linkButton: "d",
    });
    expect(await getGenerationStatus("gen_1", "workspace_other")).toBeNull();
  });

  it("records finalCopy with the edit distance from the model output", async () => {
    mockPrisma.copyGeneration.findUnique.mockResolvedValue(
      generationRow({
        status: "DONE",
        output: {
          openingDm: "abc",
          openingButton: "x",
          revealDm: "same",
          linkButton: "y",
        },
      })
    );
    const result = await recordFinalCopy("gen_1", "workspace_1", {
      automationId: "automation_1",
      finalCopy: {
        openingDm: "abd",
        openingButton: "x",
        revealDm: "same",
        linkButton: "y",
      },
    });
    expect(result).toEqual({ editDistance: 1 });
    expect(mockPrisma.copyGeneration.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          automationId: "automation_1",
          editDistance: 1,
        }),
      })
    );
  });

  it("records finalCopy with a null distance when the generation never produced output", async () => {
    mockPrisma.copyGeneration.findUnique.mockResolvedValue(
      generationRow({ status: "FAILED" })
    );
    const result = await recordFinalCopy("gen_1", "workspace_1", {
      automationId: "automation_1",
      finalCopy: STANDARD_COPY,
    });
    expect(result).toEqual({ editDistance: null });
  });

  it("returns null for another workspace", async () => {
    mockPrisma.copyGeneration.findUnique.mockResolvedValue(generationRow());
    expect(
      await recordFinalCopy("gen_1", "workspace_other", {
        automationId: "automation_1",
        finalCopy: STANDARD_COPY,
      })
    ).toBeNull();
    expect(mockPrisma.copyGeneration.update).not.toHaveBeenCalled();
  });
});

describe("purge and misc", () => {
  it("purges rows older than 90 days", async () => {
    const now = new Date("2026-11-12T10:00:00Z");
    await purgeExpiredCopyGenerations(now);
    expect(mockPrisma.copyGeneration.deleteMany).toHaveBeenCalledTimes(1);
    const where = mockPrisma.copyGeneration.deleteMany.mock.calls[0][0].where;
    expect(where.createdAt.lt.getTime()).toBe(
      now.getTime() - 90 * 24 * 60 * 60 * 1000
    );
  });

  it("maps a CampaignCopy onto the stored four fields", () => {
    expect(
      storedCopyFromCampaignCopy({
        name: "n",
        goal: "g",
        openingDmMessage: "o",
        openingDmButtonLabel: "ob",
        dmMessage: "r",
        linkButtonLabel: "l",
        trackedDestinationUrl: "https://yoyaku.io/release/x/",
      })
    ).toEqual({
      openingDm: "o",
      openingButton: "ob",
      revealDm: "r",
      linkButton: "l",
    });
  });

  it("exposes the strict JSON schema delivered in the claim payload", () => {
    expect(COPY_SCHEMA.required).toEqual([
      "openingDm",
      "openingButton",
      "revealDm",
      "linkButton",
    ]);
    expect(COPY_SCHEMA.properties.openingDm.maxLength).toBe(160);
    expect(COPY_SCHEMA.properties.revealDm.maxLength).toBe(280);
    expect(COPY_SCHEMA.properties.openingButton.maxLength).toBe(20);
  });

  it("renders a repair appendix with the violations and the previous output", () => {
    const appendix = repairAppendix(
      [{ rule: "no-dashes", detail: "em dash found" }],
      '{"openingDm":"bad — copy"}'
    );
    expect(appendix).toContain("- no-dashes: em dash found");
    expect(appendix).toContain('{"openingDm":"bad — copy"}');
    expect(appendix).toContain("JSON only");
  });

  it("raises CopywriterError with a stable code", () => {
    const error = new CopywriterError("NOT_FOUND", 404);
    expect(error.code).toBe("NOT_FOUND");
    expect(error.status).toBe(404);
  });
});
