import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const { mockPrisma, mockTx } = vi.hoisted(() => {
  const mockTx = {
    $queryRaw: vi.fn(),
    copyGeneration: {
      count: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    copywriterPrompt: {
      findFirst: vi.fn(),
      create: vi.fn(),
      aggregate: vi.fn(),
      updateMany: vi.fn(),
    },
  };
  const mockPrisma = {
    $transaction: vi.fn(async (input: unknown) =>
      Array.isArray(input)
        ? Promise.all(input)
        : (input as (tx: typeof mockTx) => unknown)(mockTx)
    ),
    $queryRaw: vi.fn(),
    copyGeneration: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    copywriterPrompt: {
      findFirst: vi.fn(),
      create: vi.fn(),
      aggregate: vi.fn(),
      updateMany: vi.fn(),
    },
    automation: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    workspaceMember: { findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
  };
  return { mockPrisma, mockTx };
});

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import {
  activateDraft,
  addGoldenExample,
  assertValidPromptBody,
  checkPromptBody,
  createPromptVersion,
  createTrialRun,
  exampleBlock,
  getLabMetrics,
  inputKey,
  labMetricsFromRows,
  removeGoldenExample,
  revertToPrompt,
  trialVerdict,
  EXAMPLES_CAP,
} from "@/lib/copywriter/lab";
import {
  applyGenerationToAutomation,
  canonicalJson,
  recordFinalCopy,
} from "@/lib/copywriter/service";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

// Mirror of the service's private draft binding: body + rendered examples.
const draftHash = (body: string, examples: readonly string[]) =>
  sha256(`${body}\n---EXAMPLES---\n${canonicalJson(examples)}`);

const ACTIVE_PROMPT = {
  id: "prompt_1",
  workspaceId: "workspace_1",
  version: 3,
  body: "FACTS:\n{{facts}}\nSTATE: {{state}}\n{{examples}}",
  model: "haiku",
  isActive: true,
  authorEmail: "owner@yoyaku.fr",
  reason: "v3",
  examples: ["FACTS {\"sku\":\"A\"} → OUTPUT {\"revealDm\":\"x\",\"linkButton\":\"y\"}"],
};

function recentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "gen_recent",
    workspaceId: "workspace_1",
    automationId: null,
    autoApply: false,
    isTrial: false,
    status: "DONE",
    failureCode: null,
    promptId: "prompt_1",
    promptVersion: 3,
    input: {
      facts: { sku: "LM-02", title: "Likemind 02", state: "restock" },
      caption: "",
    },
    renderedPrompt: "R",
    standardCopy: { openingDm: null, openingButton: null, revealDm: "s", linkButton: "l" },
    output: null,
    lintErrors: null,
    tier: null,
    latencyMs: null,
    createdAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTx.$queryRaw.mockResolvedValue([]);
  mockTx.copyGeneration.count.mockResolvedValue(0);
  mockTx.copyGeneration.create.mockResolvedValue({ id: "gen_tx_new" });
  mockTx.copyGeneration.updateMany.mockResolvedValue({ count: 1 });
  mockTx.copywriterPrompt.create.mockResolvedValue({ id: "prompt_tx_new", version: 4 });
  mockTx.copywriterPrompt.aggregate.mockResolvedValue({ _max: { version: 3 } });
  mockTx.copywriterPrompt.updateMany.mockResolvedValue({ count: 1 });
  // The activation's expected-active check: same active row by default.
  mockTx.copywriterPrompt.findFirst.mockResolvedValue({
    id: "prompt_1",
    isActive: true,
  });
  mockPrisma.copywriterPrompt.findFirst.mockResolvedValue(ACTIVE_PROMPT);
  mockPrisma.copywriterPrompt.aggregate.mockResolvedValue({ _max: { version: 3 } });
  mockPrisma.copywriterPrompt.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.copyGeneration.count.mockResolvedValue(0);
  mockPrisma.copyGeneration.findMany.mockResolvedValue([]);
  mockPrisma.copyGeneration.findFirst.mockResolvedValue(null);
  mockPrisma.copyGeneration.findUnique.mockResolvedValue(null);
  mockPrisma.copyGeneration.update.mockResolvedValue({});
  mockPrisma.automation.findFirst.mockResolvedValue({ id: "automation_1" });
  mockPrisma.automation.findMany.mockResolvedValue([]);
  mockPrisma.automation.updateMany.mockResolvedValue({ count: 1 });
});

describe("checkPromptBody", () => {
  it("accepts every allowed placeholder", () => {
    const check = checkPromptBody(
      "Use {{facts}}, {{description}}, {{caption}}, {{state}} and {{examples}}."
    );
    expect(check).toEqual({ unknownPlaceholders: [], tooLong: false });
  });

  it("refuses an unknown {{foo}} placeholder", () => {
    const check = checkPromptBody("Say {{foo}} and {{state}}.");
    expect(check.unknownPlaceholders).toEqual(["foo"]);
    expect(() => assertValidPromptBody("{{foo}}")).toThrowError(
      expect.objectContaining({ code: "UNKNOWN_PLACEHOLDER", status: 400 })
    );
  });

  it("recognises a padded placeholder by its trimmed name", () => {
    const check = checkPromptBody("{{ facts }}");
    expect(check.unknownPlaceholders).toEqual([]);
  });

  it("refuses a body above 4000 characters", async () => {
    const long = "x".repeat(4001);
    expect(checkPromptBody(long).tooLong).toBe(true);
    await expect(
      createPromptVersion({
        workspaceId: "workspace_1",
        body: long,
        model: "haiku",
        reason: "r",
        authorEmail: "owner@yoyaku.fr",
      })
    ).rejects.toMatchObject({ code: "PROMPT_BODY_TOO_LONG", status: 400 });
  });
});

describe("createPromptVersion", () => {
  it("appends version N+1 and flips the active row in one transaction", async () => {
    const created = await createPromptVersion({
      workspaceId: "workspace_1",
      body: "NEW BODY {{state}}",
      model: "sonnet",
      reason: "tighter state rules",
      authorEmail: "owner@yoyaku.fr",
      activate: true,
    });
    expect(mockTx.copywriterPrompt.aggregate).toHaveBeenCalledWith({
      where: { workspaceId: "workspace_1" },
      _max: { version: true },
    });
    expect(mockTx.copywriterPrompt.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: "workspace_1", isActive: true },
      data: { isActive: false },
    });
    const data = mockTx.copywriterPrompt.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      version: 4,
      body: "NEW BODY {{state}}",
      model: "sonnet",
      isActive: true,
      reason: "tighter state rules",
    });
    expect(created).toMatchObject({ id: "prompt_tx_new" });
  });

  it("stores examples on the new version (cap 3)", async () => {
    await createPromptVersion({
      workspaceId: "workspace_1",
      body: "b",
      model: "haiku",
      reason: "r",
      authorEmail: "o@x",
      examples: ["a", "b", "c"],
      activate: true,
    });
    const data = mockTx.copywriterPrompt.create.mock.calls[0][0].data;
    expect(data.examples).toEqual(["a", "b", "c"]);

    await expect(
      createPromptVersion({
        workspaceId: "workspace_1",
        body: "b",
        model: "haiku",
        reason: "r",
        authorEmail: "o@x",
        examples: ["1", "2", "3", "4"],
      })
    ).rejects.toMatchObject({ code: "EXAMPLES_CAP_REACHED" });
    expect(EXAMPLES_CAP).toBe(3);
  });

  it("refuses a bad model or an empty reason", async () => {
    await expect(
      createPromptVersion({
        workspaceId: "workspace_1",
        body: "b",
        model: "opus",
        reason: "r",
        authorEmail: "o@x",
      })
    ).rejects.toMatchObject({ code: "INVALID_MODEL" });
    await expect(
      createPromptVersion({
        workspaceId: "workspace_1",
        body: "b",
        model: "haiku",
        reason: "  ",
        authorEmail: "o@x",
      })
    ).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    expect(mockTx.copywriterPrompt.create).not.toHaveBeenCalled();
  });

  it("a draft version does not deactivate the active row", async () => {
    await createPromptVersion({
      workspaceId: "workspace_1",
      body: "draft",
      model: "haiku",
      reason: "wip",
      authorEmail: "o@x",
    });
    expect(mockTx.copywriterPrompt.updateMany).not.toHaveBeenCalled();
    expect(mockTx.copywriterPrompt.create.mock.calls[0][0].data.isActive).toBe(false);
  });
});

describe("revertToPrompt", () => {
  it("creates N+1 with the old body and never rewrites the old row", async () => {
    mockPrisma.copywriterPrompt.findFirst.mockResolvedValue({
      ...ACTIVE_PROMPT,
      id: "prompt_v1",
      version: 1,
      body: "V1 BODY {{state}}",
      model: "haiku",
      examples: ["OLD EXAMPLE"],
    });
    const created = await revertToPrompt({
      workspaceId: "workspace_1",
      promptId: "prompt_v1",
      reason: "back to v1 wording",
      authorEmail: "owner@yoyaku.fr",
    });
    const data = mockTx.copywriterPrompt.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      version: 4,
      body: "V1 BODY {{state}}",
      model: "haiku",
      isActive: true,
      reason: "back to v1 wording",
    });
    expect(data.examples).toEqual(["OLD EXAMPLE"]);
    expect(created).toMatchObject({ id: "prompt_tx_new" });
    // The only mutation on old rows is the isActive flip; nothing touches a
    // body. (updateMany is the deactivate, there is no `update` on prompts.)
    expect(mockTx.copywriterPrompt.updateMany).toHaveBeenCalledTimes(1);
  });

  it("answers NOT_FOUND for another workspace's prompt", async () => {
    mockPrisma.copywriterPrompt.findFirst.mockResolvedValue(null);
    await expect(
      revertToPrompt({
        workspaceId: "workspace_1",
        promptId: "prompt_foreign",
        reason: "r",
        authorEmail: "o@x",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(mockTx.copywriterPrompt.create).not.toHaveBeenCalled();
  });
});

describe("metrics", () => {
  const FIXTURE = [
    {
      promptVersion: 1,
      generations: 4,
      lintPassFirstAttempt: 4,
      repairs: 0,
      fallbacks: 0,
      acceptedWithoutEdit: 2,
      medianEditDistance: "2",
      medianLatency: "5100",
      tierMix: { haiku: 4 },
    },
    {
      promptVersion: 2,
      generations: 12,
      lintPassFirstAttempt: 9,
      repairs: 2,
      fallbacks: 1,
      acceptedWithoutEdit: 5,
      medianEditDistance: 7,
      medianLatency: 8200,
      tierMix: { haiku: 9, claude: 3 },
    },
  ];

  it("projects aggregate rows onto readable metrics on a fixture", () => {
    const metrics = labMetricsFromRows(FIXTURE);
    expect(metrics[0]).toMatchObject({
      promptVersion: 1,
      generations: 4,
      lintPassFirstAttempt: 4,
      repairRate: 0,
      fallbackRate: 0,
      acceptedWithoutEdit: 2,
      medianEditDistance: 2,
      medianLatencyMs: 5100,
      tierMix: { haiku: 4 },
      enoughData: false, // 4 < 5 generations
    });
    expect(metrics[1]).toMatchObject({
      promptVersion: 2,
      repairRate: 2 / 12,
      fallbackRate: 1 / 12,
      enoughData: true,
      tierMix: { haiku: 9, claude: 3 },
    });
  });

  it("runs one bounded GROUP BY excluding trials over the last 90 days", async () => {
    mockPrisma.$queryRaw.mockResolvedValue(FIXTURE);
    const metrics = await getLabMetrics("workspace_1", new Date("2026-11-12T10:00:00Z"));
    expect(metrics).toHaveLength(2);
    const [template, workspaceId, since] = mockPrisma.$queryRaw.mock.calls[0];
    const sql = template.join("?");
    expect(sql).toContain('GROUP BY g."promptVersion"');
    expect(sql).toContain('g."isTrial" = false');
    expect(sql).toContain('g."createdAt" >= ?');
    expect(sql).toContain("PERCENTILE_CONT(0.5)");
    // A repaired generation is ONE generation and never a fallback.
    expect(sql).toContain('COUNT(*) FILTER (WHERE g."attempt" = 1)');
    expect(sql).toContain(`g."failureCode" IS DISTINCT FROM 'LINT_REPAIR_QUEUED'`);
    expect(workspaceId).toBe("workspace_1");
    expect((since as Date).getTime()).toBe(
      new Date("2026-08-14T10:00:00Z").getTime()
    );
  });
});

describe("inputKey", () => {
  it("is order-insensitive for equal JSON values", () => {
    expect(inputKey({ facts: { sku: "A", title: "T" }, caption: "c" })).toBe(
      inputKey({ caption: "c", facts: { title: "T", sku: "A" } })
    );
    expect(inputKey({ facts: { sku: "A" } })).not.toBe(
      inputKey({ facts: { sku: "B" } })
    );
  });
});

describe("createTrialRun", () => {
  it("refuses a second concurrent run per workspace, before any quota is spent", async () => {
    mockPrisma.copyGeneration.findMany.mockResolvedValue([
      recentRow({ id: "g1", input: { facts: { sku: "A", state: "restock" }, caption: "" } }),
    ]);
    mockTx.copyGeneration.count.mockResolvedValue(1);
    await expect(
      createTrialRun({
        workspaceId: "workspace_1",
        body: "DRAFT {{state}}",
        model: "haiku",
        authorEmail: "o@x",
      })
    ).rejects.toMatchObject({ code: "TRIAL_IN_PROGRESS", status: 409 });
    expect(mockTx.copyGeneration.create).not.toHaveBeenCalled();
    // The in-flight check runs under the per-workspace advisory lock.
    const lockSql = mockTx.$queryRaw.mock.calls[0][0].join("?");
    expect(lockSql).toContain("pg_advisory_xact_lock");
    expect(mockTx.$queryRaw.mock.calls[0][1]).toBe("workspace_1");
    const countBeforeCreate =
      mockTx.copyGeneration.create.mock.invocationCallOrder[0] ?? Infinity;
    expect(mockTx.copyGeneration.count.mock.invocationCallOrder[0]).toBeLessThan(
      countBeforeCreate
    );
  });

  it("queues one trial per recent DISTINCT input, capped at 5, fully isolated", async () => {
    mockPrisma.copyGeneration.findMany.mockResolvedValue([
      recentRow({ id: "g1", input: { facts: { sku: "A", state: "restock" }, caption: "" } }),
      recentRow({ id: "g2", input: { facts: { sku: "A", state: "restock" }, caption: "" } }), // duplicate
      recentRow({ id: "g3", input: { facts: { sku: "B", state: "preorder" }, caption: "" } }),
      recentRow({ id: "g4", input: { facts: { sku: "C", state: "available" }, caption: "" } }),
    ]);
    const run = await createTrialRun({
      workspaceId: "workspace_1",
      body: "DRAFT MARKER {{state}}\n{{examples}}",
      model: "sonnet",
      authorEmail: "owner@yoyaku.fr",
    });
    expect(run.ids).toEqual(["gen_tx_new", "gen_tx_new", "gen_tx_new"]);
    const creates = mockTx.copyGeneration.create.mock.calls.map((c) => c[0].data);
    expect(creates).toHaveLength(3);
    for (const data of creates) {
      expect(data.isTrial).toBe(true);
      expect(data.automationId).toBeNull();
      expect(data.autoApply).toBe(false);
      expect(data.promptId).toBe("prompt_1");
      expect(data.promptVersion).toBe(3);
      // The draft's model travels with the row and the trial is bound to
      // this exact body AND the examples it was rendered with.
      expect(data.modelOverride).toBe("sonnet");
      expect(data.trialBodyHash).toBe(
        draftHash("DRAFT MARKER {{state}}\n{{examples}}", ACTIVE_PROMPT.examples)
      );
      expect(data.renderedPrompt).toContain("DRAFT MARKER");
      // The active prompt's examples travel with the draft.
      expect(data.renderedPrompt).toContain("GOLDEN EXAMPLES");
    }
    // Distinct inputs: A, B, C — not four copies of A.
    expect(creates[0].input.facts.sku).toBe("A");
    expect(creates[1].input.facts.sku).toBe("B");
    expect(creates[2].input.facts.sku).toBe("C");
    // Each trial renders its own facts into the draft body.
    expect(creates[0].renderedPrompt).toContain("restock");
    expect(creates[1].renderedPrompt).toContain("preorder");
    expect(creates[2].renderedPrompt).toContain("available");
  });

  it("caps the run at 5 generations even with more distinct inputs", async () => {
    const rows = ["A", "B", "C", "D", "E", "F", "G", "H"].map((sku, i) =>
      recentRow({ id: `g${i}`, input: { facts: { sku }, caption: "" } })
    );
    mockPrisma.copyGeneration.findMany.mockResolvedValue(rows);
    const run = await createTrialRun({
      workspaceId: "workspace_1",
      body: "b {{state}}",
      model: "haiku",
      authorEmail: "o@x",
    });
    expect(run.ids).toHaveLength(5);
    expect(mockTx.copyGeneration.create).toHaveBeenCalledTimes(5);
  });

  it("refuses the run when there is no recent input at all", async () => {
    mockPrisma.copyGeneration.findMany.mockResolvedValue([]);
    await expect(
      createTrialRun({
        workspaceId: "workspace_1",
        body: "b {{state}}",
        model: "haiku",
        authorEmail: "o@x",
      })
    ).rejects.toMatchObject({ code: "NO_TRIAL_INPUTS" });
  });

  it("skips sources without a facts record instead of rendering a fake shape", async () => {
    mockPrisma.copyGeneration.findMany.mockResolvedValue([
      recentRow({ id: "bad", input: { caption: "no facts here" } }),
      recentRow({ id: "worse", input: "not even an object" }),
      recentRow({ id: "good", input: { facts: { sku: "A", state: "restock" }, caption: "" } }),
    ]);
    const run = await createTrialRun({
      workspaceId: "workspace_1",
      body: "b {{state}}",
      model: "haiku",
      authorEmail: "o@x",
    });
    expect(run.ids).toHaveLength(1);
    const data = mockTx.copyGeneration.create.mock.calls[0][0].data;
    expect(data.input.facts.sku).toBe("A");
  });

  it("validates the draft body before spending quota", async () => {
    await expect(
      createTrialRun({
        workspaceId: "workspace_1",
        body: "bad {{nope}}",
        model: "haiku",
        authorEmail: "o@x",
      })
    ).rejects.toMatchObject({ code: "UNKNOWN_PLACEHOLDER" });
    expect(mockPrisma.copyGeneration.findMany).not.toHaveBeenCalled();
  });
});

describe("trialVerdict (activation gate)", () => {
  const INPUT_A = { facts: { sku: "A", state: "restock" }, caption: "" };
  const INPUT_B = { facts: { sku: "B", state: "preorder" }, caption: "" };
  const INPUT_C = { facts: { sku: "C", state: "available" }, caption: "" };
  const INPUT_D = { facts: { sku: "D", state: "restock" }, caption: "" };

  function setupTrials(
    trialRows: Array<Record<string, unknown>>,
    tailRows: Array<Record<string, unknown>>
  ) {
    mockPrisma.copyGeneration.findMany.mockImplementation((arg: {
      where: {
        id?: { in?: string[] };
        isTrial?: boolean;
        trialBodyHash?: string;
        modelOverride?: string;
      };
    }) => {
      if (arg.where.id?.in) {
        // The verdict only sees the ids the caller submitted.
        return Promise.resolve(
          trialRows.filter((row) => arg.where!.id!.in!.includes(row.id as string))
        );
      }
      if (arg.where.trialBodyHash) {
        // The run-lookup is filtered by body hash AND model and counts
        // ROOT rows only (repair rows carry sourceGenerationId). Newest
        // first, like the real query.
        return Promise.resolve(
          trialRows
            .filter(
              (row) =>
                row.trialBodyHash === arg.where!.trialBodyHash &&
                row.modelOverride === arg.where!.modelOverride &&
                !row.sourceGenerationId
            )
            .sort(
              (a, b) =>
                (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime()
            )
        );
      }
      return Promise.resolve(tailRows);
    });
  }

  // One run = one transaction: all roots share the same createdAt.
  const RUN_TS = new Date("2026-11-12T12:00:00Z");

  function boundTrial(
    id: string,
    body: string,
    model: string,
    input: unknown,
    status: string,
    examples: readonly string[] = ACTIVE_PROMPT.examples
  ) {
    return recentRow({
      id,
      isTrial: true,
      status,
      input,
      createdAt: RUN_TS,
      modelOverride: model,
      trialBodyHash: draftHash(body, examples),
    });
  }

  function baselineRow(id: string, input: unknown, status: string) {
    return recentRow({ id, status, input, promptVersion: 3 });
  }

  it("gate passes when the trial lint pass matches the baseline", async () => {
    setupTrials(
      [
        boundTrial("t1", "b {{state}}", "haiku", INPUT_A, "DONE"),
        boundTrial("t2", "b {{state}}", "haiku", INPUT_B, "FAILED"),
        boundTrial("t3", "b {{state}}", "haiku", INPUT_C, "DONE"),
      ],
      [
        baselineRow("p1", INPUT_A, "DONE"),
        baselineRow("p2", INPUT_B, "FAILED"),
        baselineRow("p3", INPUT_C, "DONE"),
      ]
    );
    const verdict = await trialVerdict("workspace_1", ["t1", "t2", "t3"]);
    expect(verdict).toEqual({
      ready: true,
      trialPass: 2,
      baselinePass: 2,
      comparablePass: 2,
      baselinesFound: 3,
      gateOk: true,
    });
  });

  it("gate refuses a trial whose lint pass is worse than the baseline", async () => {
    setupTrials(
      [
        boundTrial("t1", "b {{state}}", "haiku", INPUT_A, "FAILED"),
        boundTrial("t2", "b {{state}}", "haiku", INPUT_B, "FAILED"),
        boundTrial("t3", "b {{state}}", "haiku", INPUT_C, "FAILED"),
      ],
      [
        baselineRow("p1", INPUT_A, "DONE"),
        baselineRow("p2", INPUT_B, "FAILED"),
        baselineRow("p3", INPUT_C, "DONE"),
      ]
    );
    const verdict = await trialVerdict("workspace_1", ["t1", "t2", "t3"]);
    expect(verdict).toMatchObject({
      ready: true,
      trialPass: 0,
      baselinePass: 2,
      comparablePass: 0,
      baselinesFound: 3,
      gateOk: false,
    });
  });

  it("gate compares draft and baseline over the SAME inputs", async () => {
    // t1 failed where the active version passed; t2 passed but has NO
    // baseline; t3 failed on a passed baseline; t4 passed on a failed one.
    // Counting the draft over ALL items would let t2's pass ride over the
    // comparable failures — the comparison must stay on the baseline set.
    setupTrials(
      [
        boundTrial("t1", "b {{state}}", "haiku", INPUT_A, "FAILED"),
        boundTrial("t2", "b {{state}}", "haiku", INPUT_B, "DONE"),
        boundTrial("t3", "b {{state}}", "haiku", INPUT_C, "FAILED"),
        boundTrial("t4", "b {{state}}", "haiku", INPUT_D, "DONE"),
      ],
      [
        baselineRow("p1", INPUT_A, "DONE"),
        baselineRow("p3", INPUT_C, "DONE"),
        baselineRow("p4", INPUT_D, "FAILED"),
      ]
    );
    const verdict = await trialVerdict("workspace_1", ["t1", "t2", "t3", "t4"]);
    expect(verdict).toMatchObject({
      ready: true,
      trialPass: 2,
      baselinePass: 2,
      comparablePass: 1,
      baselinesFound: 3,
      gateOk: false,
    });
  });

  it("gate refuses below 3 comparable baselines (evidence too thin)", async () => {
    setupTrials(
      [
        boundTrial("t1", "b {{state}}", "haiku", INPUT_A, "DONE"),
        boundTrial("t2", "b {{state}}", "haiku", INPUT_B, "DONE"),
        boundTrial("t3", "b {{state}}", "haiku", INPUT_C, "DONE"),
      ],
      [baselineRow("p1", INPUT_A, "DONE")]
    );
    const verdict = await trialVerdict("workspace_1", ["t1", "t2", "t3"]);
    expect(verdict).toMatchObject({
      ready: true,
      trialPass: 3,
      baselinePass: 1,
      baselinesFound: 1,
      gateOk: false,
    });
    // The owner can still decide, through the recorded override.
    await expect(
      activateDraft({
        workspaceId: "workspace_1",
        body: "b {{state}}",
        model: "haiku",
        reason: "thin evidence, owner decision",
        authorEmail: "o@x",
        trialIds: ["t1", "t2", "t3"],
      })
    ).rejects.toMatchObject({ code: "ACTIVATION_GATE_FAILED" });
    expect(mockTx.copywriterPrompt.create).not.toHaveBeenCalled();
  });

  it("gate refuses when the active version has no baseline rows yet", async () => {
    // A freshly activated version: trials run, but nothing to compare with.
    setupTrials(
      [
        boundTrial("t1", "b {{state}}", "haiku", INPUT_A, "DONE"),
        boundTrial("t2", "b {{state}}", "haiku", INPUT_B, "DONE"),
        boundTrial("t3", "b {{state}}", "haiku", INPUT_C, "DONE"),
      ],
      []
    );
    const verdict = await trialVerdict("workspace_1", ["t1", "t2", "t3"]);
    expect(verdict).toMatchObject({
      ready: true,
      trialPass: 3,
      baselinePass: 0,
      baselinesFound: 0,
      gateOk: false,
    });
    await expect(
      activateDraft({
        workspaceId: "workspace_1",
        body: "b {{state}}",
        model: "haiku",
        reason: "no baseline yet",
        authorEmail: "o@x",
        trialIds: ["t1", "t2", "t3"],
      })
    ).rejects.toMatchObject({ code: "ACTIVATION_GATE_FAILED" });
    expect(mockTx.copywriterPrompt.create).not.toHaveBeenCalled();
  });

  it("baseline follows the repair link like the trial side", async () => {
    setupTrials(
      [
        boundTrial("t1", "b {{state}}", "haiku", INPUT_A, "DONE"),
        boundTrial("t2", "b {{state}}", "haiku", INPUT_B, "DONE"),
        boundTrial("t3", "b {{state}}", "haiku", INPUT_C, "FAILED"),
      ],
      [
        recentRow({
          id: "p1",
          status: "FAILED",
          failureCode: "LINT_REPAIR_QUEUED",
          input: INPUT_A,
          promptVersion: 3,
        }),
        baselineRow("p2", INPUT_B, "FAILED"),
        baselineRow("p3", INPUT_C, "DONE"),
      ]
    );
    // The active version's first attempt queued a repair that passed.
    mockPrisma.copyGeneration.findFirst.mockResolvedValue(
      recentRow({ id: "p1_repair", status: "DONE", attempt: 2, input: INPUT_A })
    );
    const verdict = await trialVerdict("workspace_1", ["t1", "t2", "t3"]);
    expect(verdict).toMatchObject({
      trialPass: 2,
      baselinePass: 2,
      baselinesFound: 3,
      gateOk: true,
    });
  });

  it("refuses activation without any trial or override", async () => {
    await expect(
      activateDraft({
        workspaceId: "workspace_1",
        body: "b {{state}}",
        model: "haiku",
        reason: "no trial",
        authorEmail: "o@x",
      })
    ).rejects.toMatchObject({ code: "ACTIVATION_GATE_FAILED", status: 409 });
    expect(mockTx.copywriterPrompt.create).not.toHaveBeenCalled();
  });

  it("refuses trial ids that belong to a DIFFERENT draft body", async () => {
    // The trials themselves are gate-passing (3/3 done, 3 comparable DONE
    // baselines): the binding is the ONLY reason this activation fails.
    setupTrials(
      [
        boundTrial("t1", "BODY A {{state}}", "haiku", INPUT_A, "DONE"),
        boundTrial("t2", "BODY A {{state}}", "haiku", INPUT_B, "DONE"),
        boundTrial("t3", "BODY A {{state}}", "haiku", INPUT_C, "DONE"),
      ],
      [
        baselineRow("p1", INPUT_A, "DONE"),
        baselineRow("p2", INPUT_B, "DONE"),
        baselineRow("p3", INPUT_C, "DONE"),
      ]
    );
    // The owner tested BODY A but submits BODY B with A's trial ids.
    await expect(
      activateDraft({
        workspaceId: "workspace_1",
        body: "BODY B {{state}}",
        model: "haiku",
        reason: "gate bypass attempt",
        authorEmail: "o@x",
        trialIds: ["t1", "t2", "t3"],
      })
    ).rejects.toMatchObject({ code: "ACTIVATION_GATE_FAILED", status: 409 });
    expect(mockTx.copywriterPrompt.create).not.toHaveBeenCalled();
  });

  it("refuses trials that ran with DIFFERENT golden examples", async () => {
    // The active version gained an example after the trial ran: the draft
    // as it would be activated was never tested.
    setupTrials(
      [
        boundTrial("t1", "b {{state}}", "haiku", INPUT_A, "DONE"),
        boundTrial("t2", "b {{state}}", "haiku", INPUT_B, "DONE"),
        boundTrial("t3", "b {{state}}", "haiku", INPUT_C, "DONE"),
      ],
      [
        baselineRow("p1", INPUT_A, "DONE"),
        baselineRow("p2", INPUT_B, "DONE"),
        baselineRow("p3", INPUT_C, "DONE"),
      ]
    );
    mockPrisma.copywriterPrompt.findFirst.mockResolvedValue({
      ...ACTIVE_PROMPT,
      examples: [...ACTIVE_PROMPT.examples, "FACTS {\"sku\":\"NEW\"} → OUTPUT {}"],
    });
    await expect(
      activateDraft({
        workspaceId: "workspace_1",
        body: "b {{state}}",
        model: "haiku",
        reason: "examples changed after the trial",
        authorEmail: "o@x",
        trialIds: ["t1", "t2", "t3"],
      })
    ).rejects.toMatchObject({ code: "ACTIVATION_GATE_FAILED" });
    expect(mockTx.copywriterPrompt.create).not.toHaveBeenCalled();
  });

  it("refuses trials that ran on a different model than the draft", async () => {
    // Gate-passing trials: the binding is the only rejection reason.
    setupTrials(
      [
        boundTrial("t1", "b {{state}}", "haiku", INPUT_A, "DONE"),
        boundTrial("t2", "b {{state}}", "haiku", INPUT_B, "DONE"),
        boundTrial("t3", "b {{state}}", "haiku", INPUT_C, "DONE"),
      ],
      [
        baselineRow("p1", INPUT_A, "DONE"),
        baselineRow("p2", INPUT_B, "DONE"),
        baselineRow("p3", INPUT_C, "DONE"),
      ]
    );
    await expect(
      activateDraft({
        workspaceId: "workspace_1",
        body: "b {{state}}",
        model: "sonnet",
        reason: "model swap after the trial",
        authorEmail: "o@x",
        trialIds: ["t1", "t2", "t3"],
      })
    ).rejects.toMatchObject({ code: "ACTIVATION_GATE_FAILED", status: 409 });
    expect(mockTx.copywriterPrompt.create).not.toHaveBeenCalled();
  });

  it("in-flight baselines are not comparable (gate refuses)", async () => {
    // Three baselines, none terminal: PENDING, a queued repair with no
    // repair row yet, and a queued repair whose repair row is CLAIMED.
    setupTrials(
      [
        boundTrial("t1", "b {{state}}", "haiku", INPUT_A, "FAILED"),
        boundTrial("t2", "b {{state}}", "haiku", INPUT_B, "FAILED"),
        boundTrial("t3", "b {{state}}", "haiku", INPUT_C, "FAILED"),
      ],
      [
        recentRow({ id: "p1", status: "PENDING", input: INPUT_A, promptVersion: 3 }),
        recentRow({
          id: "p2",
          status: "FAILED",
          failureCode: "LINT_REPAIR_QUEUED",
          input: INPUT_B,
          promptVersion: 3,
        }),
        recentRow({
          id: "p3",
          status: "FAILED",
          failureCode: "LINT_REPAIR_QUEUED",
          input: INPUT_C,
          promptVersion: 3,
        }),
      ]
    );
    mockPrisma.copyGeneration.findFirst.mockImplementation((arg: {
      where: { sourceGenerationId?: string };
    }) => {
      if (arg.where.sourceGenerationId === "p3") {
        return Promise.resolve(
          recentRow({ id: "p3_repair", status: "CLAIMED", attempt: 2, input: INPUT_C })
        );
      }
      return Promise.resolve(null);
    });
    const verdict = await trialVerdict("workspace_1", ["t1", "t2", "t3"]);
    // Nothing was comparable: the gate refuses even though the draft's own
    // outcomes are all terminal.
    expect(verdict).toMatchObject({
      ready: true,
      trialPass: 0,
      baselinePass: 0,
      baselinesFound: 0,
      gateOk: false,
    });
  });

  it("refuses a cherry-picked subset of the run's trial ids", async () => {
    // The full run lost 2 of 3; submitting only the passing id must not
    // satisfy the gate.
    setupTrials(
      [
        boundTrial("t1", "b {{state}}", "haiku", INPUT_A, "DONE"),
        boundTrial("t2", "b {{state}}", "haiku", INPUT_B, "FAILED"),
        boundTrial("t3", "b {{state}}", "haiku", INPUT_C, "FAILED"),
      ],
      [
        baselineRow("p1", INPUT_A, "DONE"),
        baselineRow("p2", INPUT_B, "DONE"),
        baselineRow("p3", INPUT_C, "DONE"),
      ]
    );
    await expect(
      activateDraft({
        workspaceId: "workspace_1",
        body: "b {{state}}",
        model: "haiku",
        reason: "only the passing one",
        authorEmail: "o@x",
        trialIds: ["t1"],
      })
    ).rejects.toMatchObject({ code: "ACTIVATION_GATE_FAILED" });
    expect(mockTx.copywriterPrompt.create).not.toHaveBeenCalled();
  });

  it("refuses activation when the gate fails", async () => {
    setupTrials(
      [
        boundTrial("t1", "b {{state}}", "haiku", INPUT_A, "FAILED"),
        boundTrial("t2", "b {{state}}", "haiku", INPUT_B, "FAILED"),
        boundTrial("t3", "b {{state}}", "haiku", INPUT_C, "FAILED"),
      ],
      [
        baselineRow("p1", INPUT_A, "DONE"),
        baselineRow("p2", INPUT_B, "DONE"),
        baselineRow("p3", INPUT_C, "DONE"),
      ]
    );
    await expect(
      activateDraft({
        workspaceId: "workspace_1",
        body: "b {{state}}",
        model: "haiku",
        reason: "worse than active",
        authorEmail: "o@x",
        trialIds: ["t1", "t2", "t3"],
      })
    ).rejects.toMatchObject({ code: "ACTIVATION_GATE_FAILED" });
    expect(mockTx.copywriterPrompt.create).not.toHaveBeenCalled();
  });

  it("refuses activation when the active prompt changed since the verdict", async () => {
    setupTrials(
      [
        boundTrial("t1", "b {{state}}", "haiku", INPUT_A, "DONE"),
        boundTrial("t2", "b {{state}}", "haiku", INPUT_B, "DONE"),
        boundTrial("t3", "b {{state}}", "haiku", INPUT_C, "DONE"),
      ],
      [
        baselineRow("p1", INPUT_A, "DONE"),
        baselineRow("p2", INPUT_B, "DONE"),
        baselineRow("p3", INPUT_C, "DONE"),
      ]
    );
    // Another owner activated a different version between the verdict and
    // the create: the transaction sees a different active row.
    mockTx.copywriterPrompt.findFirst.mockResolvedValue({
      id: "prompt_v8",
      isActive: true,
    });
    await expect(
      activateDraft({
        workspaceId: "workspace_1",
        body: "b {{state}}",
        model: "haiku",
        reason: "stale verdict",
        authorEmail: "o@x",
        trialIds: ["t1", "t2", "t3"],
      })
    ).rejects.toMatchObject({ code: "ACTIVE_PROMPT_CHANGED", status: 409 });
    expect(mockTx.copywriterPrompt.create).not.toHaveBeenCalled();
  });

  it("activates when the gate is satisfied", async () => {
    setupTrials(
      [
        boundTrial("t1", "better {{state}}", "sonnet", INPUT_A, "DONE"),
        boundTrial("t2", "better {{state}}", "sonnet", INPUT_B, "DONE"),
        boundTrial("t3", "better {{state}}", "sonnet", INPUT_C, "DONE"),
      ],
      [
        baselineRow("p1", INPUT_A, "DONE"),
        baselineRow("p2", INPUT_B, "FAILED"),
        baselineRow("p3", INPUT_C, "DONE"),
      ]
    );
    await activateDraft({
      workspaceId: "workspace_1",
      body: "better {{state}}",
      model: "sonnet",
      reason: "fewer invented nouns",
      authorEmail: "owner@yoyaku.fr",
      trialIds: ["t1", "t2", "t3"],
    });
    const data = mockTx.copywriterPrompt.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      body: "better {{state}}",
      model: "sonnet",
      isActive: true,
      version: 4,
      reason: "fewer invented nouns",
    });
  });

  it("inherits the active version's golden examples on activation", async () => {
    await activateDraft({
      workspaceId: "workspace_1",
      body: "risky {{state}}",
      model: "haiku",
      reason: "owner decision",
      authorEmail: "owner@yoyaku.fr",
      activateAnyway: true,
    });
    const data = mockTx.copywriterPrompt.create.mock.calls[0][0].data;
    expect(data.isActive).toBe(true);
    expect(data.reason).toContain("owner decision");
    expect(data.reason).toContain("override");
    // No examples were passed: the active prompt's examples carry over
    // instead of being silently dropped.
    expect(data.examples).toEqual(ACTIVE_PROMPT.examples);
  });

  it("activates with the override and records it in the reason", async () => {
    await activateDraft({
      workspaceId: "workspace_1",
      body: "risky {{state}}",
      model: "haiku",
      reason: "owner decision",
      authorEmail: "owner@yoyaku.fr",
      activateAnyway: true,
    });
    const data = mockTx.copywriterPrompt.create.mock.calls[0][0].data;
    expect(data.isActive).toBe(true);
    expect(data.reason).toContain("owner decision");
    expect(data.reason).toContain("override");
  });

  it("the run lookup ignores repair rows, so a repaired run can still activate", async () => {
    // t1 needed a repair: the repair row carries the same hash but is not
    // part of the 3-root run the page submitted.
    setupTrials(
      [
        boundTrial("t1", "b {{state}}", "haiku", INPUT_A, "DONE"),
        boundTrial("t2", "b {{state}}", "haiku", INPUT_B, "DONE"),
        boundTrial("t3", "b {{state}}", "haiku", INPUT_C, "DONE"),
        recentRow({
          id: "t1_repair",
          isTrial: true,
          status: "DONE",
          attempt: 2,
          sourceGenerationId: "t1",
          createdAt: new Date("2026-11-12T12:00:05Z"),
          modelOverride: "haiku",
          trialBodyHash: draftHash("b {{state}}", ACTIVE_PROMPT.examples),
          input: INPUT_A,
        }),
      ],
      [
        baselineRow("p1", INPUT_A, "DONE"),
        baselineRow("p2", INPUT_B, "FAILED"),
        baselineRow("p3", INPUT_C, "DONE"),
      ]
    );
    await activateDraft({
      workspaceId: "workspace_1",
      body: "b {{state}}",
      model: "haiku",
      reason: "repaired run passes",
      authorEmail: "o@x",
      trialIds: ["t1", "t2", "t3"],
    });
    expect(mockTx.copywriterPrompt.create).toHaveBeenCalledTimes(1);
    const data = mockTx.copywriterPrompt.create.mock.calls[0][0].data;
    expect(data.isActive).toBe(true);
    expect(data.reason).not.toContain("override");
  });

  it("a re-test of the same draft starts a fresh batch, not a merged run", async () => {
    // Two runs of the same body (6 roots in the window). The page submits
    // the newest batch's ids only; the gate must accept it.
    const FIRST = new Date("2026-11-12T10:00:00Z");
    const SECOND = new Date("2026-11-12T11:00:00Z");
    const root = (id: string, input: unknown, status: string, at: Date) =>
      recentRow({
        id,
        isTrial: true,
        status,
        input,
        createdAt: at,
        modelOverride: "haiku",
        trialBodyHash: draftHash("b {{state}}", ACTIVE_PROMPT.examples),
      });
    const rows = [
      root("old_1", INPUT_A, "FAILED", FIRST),
      root("old_2", INPUT_B, "FAILED", FIRST),
      root("old_3", INPUT_C, "FAILED", FIRST),
      root("new_1", INPUT_A, "DONE", SECOND),
      root("new_2", INPUT_B, "DONE", SECOND),
      root("new_3", INPUT_C, "DONE", SECOND),
    ];
    mockPrisma.copyGeneration.findMany.mockImplementation((arg: {
      where: {
        id?: { in?: string[] };
        trialBodyHash?: string;
        modelOverride?: string;
      };
    }) => {
      if (arg.where.id?.in) {
        return Promise.resolve(
          rows.filter((row) => arg.where!.id!.in!.includes(row.id))
        );
      }
      if (arg.where.trialBodyHash) {
        // Emulate the real query: newest first.
        return Promise.resolve(
          [...rows].sort(
            (a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime()
          )
        );
      }
      return Promise.resolve([
        baselineRow("p1", INPUT_A, "FAILED"),
        baselineRow("p2", INPUT_B, "FAILED"),
        baselineRow("p3", INPUT_C, "DONE"),
      ]);
    });
    await activateDraft({
      workspaceId: "workspace_1",
      body: "b {{state}}",
      model: "haiku",
      reason: "second run after the first failed",
      authorEmail: "o@x",
      trialIds: ["new_1", "new_2", "new_3"],
    });
    expect(mockTx.copywriterPrompt.create).toHaveBeenCalledTimes(1);
  });

  it("maps a version-number race onto a stable VERSION_CONFLICT 409", async () => {
    const { Prisma } = await import("@/app/generated/prisma/client");
    mockTx.copywriterPrompt.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "7.10.0",
      })
    );
    await expect(
      createPromptVersion({
        workspaceId: "workspace_1",
        body: "b {{state}}",
        model: "haiku",
        reason: "r",
        authorEmail: "o@x",
        activate: true,
      })
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 409 });
  });
});

describe("golden examples", () => {
  it("refuses a 4th example", async () => {
    mockPrisma.copywriterPrompt.findFirst.mockResolvedValue({
      ...ACTIVE_PROMPT,
      examples: ["e1", "e2", "e3"],
    });
    await expect(
      addGoldenExample("workspace_1", "FACTS {} → OUTPUT {}", "owner@yoyaku.fr")
    ).rejects.toMatchObject({ code: "EXAMPLES_CAP_REACHED", status: 400 });
    expect(mockTx.copywriterPrompt.create).not.toHaveBeenCalled();
  });

  it("appends an example by creating a NEW active version", async () => {
    const result = await addGoldenExample(
      "workspace_1",
      'FACTS {"sku":"LM-02"} → OUTPUT {}',
      "owner@yoyaku.fr"
    );
    expect(result.added).toBe(true);
    const data = mockTx.copywriterPrompt.create.mock.calls[0][0].data;
    expect(data.version).toBe(4);
    expect(data.isActive).toBe(true);
    expect(data.examples).toHaveLength(2);
    expect(data.examples[1]).toContain("LM-02");
    expect(data.reason).toContain("Add golden example");
  });

  it("is a no-op for an identical example", async () => {
    const block = ACTIVE_PROMPT.examples[0];
    const result = await addGoldenExample("workspace_1", block, "owner@yoyaku.fr");
    expect(result.added).toBe(false);
    expect(mockTx.copywriterPrompt.create).not.toHaveBeenCalled();
  });

  it("removes an example through a new version too", async () => {
    const result = await removeGoldenExample("workspace_1", 0, "owner@yoyaku.fr");
    expect(result.examples).toEqual([]);
    const data = mockTx.copywriterPrompt.create.mock.calls[0][0].data;
    // Empty list is stored as JSON NULL; the version writes are guarded by
    // the expected-active check like every other activation.
    expect(data.isActive).toBe(true);
    expect(data.reason).toContain("Remove golden example");
    expect(mockTx.copywriterPrompt.findFirst).toHaveBeenCalled();
  });

  it("refuses an example block above the 1500-character cap", async () => {
    await expect(
      addGoldenExample("workspace_1", "x".repeat(1501), "owner@yoyaku.fr")
    ).rejects.toMatchObject({ code: "EXAMPLE_TOO_LONG", status: 400 });
    expect(mockTx.copywriterPrompt.create).not.toHaveBeenCalled();
  });

  it("example operations refuse a concurrently changed active prompt", async () => {
    // Another owner activated a version between the read and the write.
    mockTx.copywriterPrompt.findFirst.mockResolvedValue({
      id: "prompt_other",
      isActive: true,
    });
    await expect(
      addGoldenExample("workspace_1", "FACTS {} → OUTPUT {}", "owner@yoyaku.fr")
    ).rejects.toMatchObject({ code: "ACTIVE_PROMPT_CHANGED", status: 409 });
    await expect(
      removeGoldenExample("workspace_1", 0, "owner@yoyaku.fr")
    ).rejects.toMatchObject({ code: "ACTIVE_PROMPT_CHANGED", status: 409 });
    expect(mockTx.copywriterPrompt.create).not.toHaveBeenCalled();
  });

  it("builds the FACTS → OUTPUT block from validated copy", () => {
    const block = exampleBlock(
      { sku: "LM-02", title: "Likemind 02", label: "Blueprint ARchives", state: "restock" },
      {
        openingDm: null,
        openingButton: null,
        revealDm: "Fighting the Discogs Sharks; Blueprint ARchives presents a reissue of Likemind 02",
        linkButton: "Grab your copy now!",
      }
    );
    expect(block).toContain('FACTS {"sku":"LM-02"');
    expect(block).toContain('"state":"restock"');
    expect(block).toContain("→ OUTPUT");
    expect(block).toContain('"linkButton":"Grab your copy now!"');
  });
});

describe("trial isolation in shared service paths", () => {
  it("a trial generation is never auto-applied to a campaign", async () => {
    mockPrisma.copyGeneration.findUnique.mockResolvedValue(
      recentRow({
        id: "trial_1",
        isTrial: true,
        status: "DONE",
        automationId: "automation_1",
        output: { openingDm: "a", openingButton: "b", revealDm: "c", linkButton: "d" },
      })
    );
    const outcome = await applyGenerationToAutomation("trial_1");
    expect(outcome).toBe("skipped_no_automation");
    expect(mockPrisma.automation.updateMany).not.toHaveBeenCalled();
  });

  it("recordFinalCopy refuses a trial row", async () => {
    mockPrisma.copyGeneration.findUnique.mockResolvedValue(
      recentRow({ id: "trial_1", isTrial: true, status: "DONE" })
    );
    const result = await recordFinalCopy("trial_1", "workspace_1", {
      automationId: "automation_1",
      finalCopy: { openingDm: null, openingButton: null, revealDm: "s", linkButton: "l" },
    });
    expect(result).toBeNull();
    expect(mockPrisma.copyGeneration.update).not.toHaveBeenCalled();
  });
});
