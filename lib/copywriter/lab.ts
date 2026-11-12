import { createHash } from "node:crypto";
import { Prisma } from "@/app/generated/prisma/client";
import {
  CopywriterError,
  canonicalJson,
  ensureActivePrompt,
  renderPrompt,
} from "@/lib/copywriter/service";
import type { CopyTexts } from "@/lib/copywriter/edit-distance";
import { isRecord } from "@/lib/copywriter/service";
import { prisma } from "@/lib/db/client";

/**
 * The prompt lab (lot S4): everything behind /settings/copywriter.
 *
 * Append-only prompts: editing, reverting and changing the golden examples
 * all create a NEW `CopywriterPrompt` version inside one transaction (the
 * partial unique index in the migration stays the race-proof backstop), so
 * per-version metrics stay attributable to the exact prompt content.
 *
 * Trials are isolated by construction: `isTrial` rows never carry an
 * automationId, are never auto-applied and are excluded from production
 * metrics — every one of them still spends the shared subscription quota,
 * which is why a run is capped at 5 inputs and a second concurrent run per
 * workspace is refused.
 */

const METRICS_WINDOW_DAYS = 90;
/** A version with fewer generations has no readable metrics. */
export const METRICS_MIN_GENERATIONS = 5;
/**
 * The gate needs enough comparable inputs to mean anything: below this,
 * "as good as the active version" would rest on one lucky input. Below the
 * threshold the owner still gets through the override, recorded.
 */
export const GATE_MIN_COMPARABLE_BASELINES = 3;
/** One golden example block above this is refused (stable EXAMPLE_TOO_LONG). */
export const EXAMPLE_MAX_LENGTH = 1500;
/** The four data blocks a prompt body may render. */
export const ALLOWED_PLACEHOLDERS = [
  "facts",
  "description",
  "caption",
  "state",
  "examples",
] as const;
export const PROMPT_BODY_MAX_LENGTH = 4000;
export const EXAMPLES_CAP = 3;
export const TRIAL_RUN_SIZE = 5;
/** How many recent rows are scanned to find 5 distinct inputs. */
const TRIAL_SOURCE_SCAN = 50;
export const LAB_MODELS = ["haiku", "sonnet"] as const;
export type LabModel = (typeof LAB_MODELS)[number];
/** Trial polling window on the lab page (same shape as the assistant). */
export const TRIAL_POLL_MAX_MS = 60 * 1000;

const PLACEHOLDER_RE = /\{\{([^{}]+)\}\}/g;

/**
 * Two owners writing versions at the same moment both read max(version)=N;
 * the unique (workspaceId, version) index lets exactly one insert win. The
 * loser surfaces as a stable 409 instead of an unmapped 500.
 */
function translateVersionConflict(error: unknown): never | void {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    throw new CopywriterError("VERSION_CONFLICT", 409);
  }
  throw error;
}

/**
 * sha256 hex of the exact rendered draft: the body TOGETHER with the golden
 * examples it was rendered with. A trial bound to this hash can never vouch
 * for a different body OR a different examples block.
 */
function draftHash(body: string, examples: readonly string[]): string {
  return createHash("sha256")
    .update(`${body}\n---EXAMPLES---\n${canonicalJson(examples)}`)
    .digest("hex");
}

/* ------------------------------ validation -------------------------------- */

export interface PromptBodyCheck {
  unknownPlaceholders: string[];
  tooLong: boolean;
}

/** Pure check of a draft prompt body against the lab rules. */
export function checkPromptBody(body: string): PromptBodyCheck {
  const unknown = new Set<string>();
  for (const match of body.matchAll(PLACEHOLDER_RE)) {
    const name = (match[1] ?? "").trim();
    if (!(ALLOWED_PLACEHOLDERS as readonly string[]).includes(name)) {
      unknown.add(name);
    }
  }
  return {
    unknownPlaceholders: [...unknown],
    tooLong: body.length > PROMPT_BODY_MAX_LENGTH,
  };
}

/**
 * Throws the stable lab error codes so routes can map them 1:1:
 * PROMPT_BODY_TOO_LONG and UNKNOWN_PLACEHOLDER (both 400).
 */
export function assertValidPromptBody(body: string): void {
  const check = checkPromptBody(body);
  if (check.tooLong) {
    throw new CopywriterError("PROMPT_BODY_TOO_LONG", 400);
  }
  if (check.unknownPlaceholders.length > 0) {
    throw new CopywriterError("UNKNOWN_PLACEHOLDER", 400);
  }
}

export function assertValidLabModel(model: string): void {
  if (!(LAB_MODELS as readonly string[]).includes(model)) {
    throw new CopywriterError("INVALID_MODEL", 400);
  }
}

function assertValidReason(reason: string): void {
  if (!reason.trim()) throw new CopywriterError("REASON_REQUIRED", 400);
}

function assertValidExamples(examples: readonly string[]): void {
  if (examples.length > EXAMPLES_CAP) {
    throw new CopywriterError("EXAMPLES_CAP_REACHED", 400);
  }
  if (examples.some((example) => typeof example !== "string" || !example.trim())) {
    throw new CopywriterError("INVALID_EXAMPLE", 400);
  }
}

/* ------------------------------- versions --------------------------------- */

function readExamplesJson(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

export interface CreatePromptVersionInput {
  workspaceId: string;
  body: string;
  model: string;
  reason: string;
  authorEmail: string;
  /** Replaces the examples on the new version. Omit to inherit none. */
  examples?: readonly string[];
  /** Flip `isActive` in the same transaction (one-active-per-workspace). */
  activate?: boolean;
  /**
   * Activation safety: refuse the write when the workspace's active prompt
   * is no longer this row (another owner activated or reverted in between)
   * — a gate verdict computed against version N must not silently replace
   * version N+1.
   */
  expectedActiveId?: string;
}

/**
 * Append a prompt version. Never mutates an existing row's content; when
 * `activate` is set, the previously active rows are deactivated inside the
 * same transaction first.
 */
export async function createPromptVersion(
  input: CreatePromptVersionInput
) {
  assertValidPromptBody(input.body);
  assertValidLabModel(input.model);
  assertValidReason(input.reason);
  const examples = input.examples ?? [];
  assertValidExamples(examples);

  try {
    return await prisma.$transaction(async (tx) => {
      const max = await tx.copywriterPrompt.aggregate({
        where: { workspaceId: input.workspaceId },
        _max: { version: true },
      });
      const activate = input.activate ?? false;
      if (activate) {
        if (input.expectedActiveId) {
          const current = await tx.copywriterPrompt.findFirst({
            where: { workspaceId: input.workspaceId, isActive: true },
          });
          if (!current || current.id !== input.expectedActiveId) {
            throw new CopywriterError("ACTIVE_PROMPT_CHANGED", 409);
          }
        }
        await tx.copywriterPrompt.updateMany({
          where: { workspaceId: input.workspaceId, isActive: true },
          data: { isActive: false },
        });
      }
      return tx.copywriterPrompt.create({
        data: {
          workspaceId: input.workspaceId,
          version: (max._max.version ?? 0) + 1,
          body: input.body,
          model: input.model,
          reason: input.reason,
          authorEmail: input.authorEmail,
          isActive: activate,
          examples:
            examples.length > 0
              ? (examples as unknown as Prisma.InputJsonValue)
              : Prisma.DbNull,
        },
      });
    });
  } catch (error) {
    translateVersionConflict(error);
  }
}

export interface RevertPromptInput {
  workspaceId: string;
  promptId: string;
  reason: string;
  authorEmail: string;
}

/**
 * Revert to vN: a NEW version (max + 1) whose body, model and examples copy
 * the target row, activated in one transaction. History stays append-only;
 * the target row itself is never rewritten.
 */
export async function revertToPrompt(input: RevertPromptInput) {
  assertValidReason(input.reason);
  const target = await prisma.copywriterPrompt.findFirst({
    where: { id: input.promptId, workspaceId: input.workspaceId },
  });
  if (!target) throw new CopywriterError("NOT_FOUND", 404);

  try {
    return await prisma.$transaction(async (tx) => {
      const max = await tx.copywriterPrompt.aggregate({
        where: { workspaceId: input.workspaceId },
        _max: { version: true },
      });
      await tx.copywriterPrompt.updateMany({
        where: { workspaceId: input.workspaceId, isActive: true },
        data: { isActive: false },
      });
      return tx.copywriterPrompt.create({
        data: {
          workspaceId: input.workspaceId,
          version: (max._max.version ?? 0) + 1,
          body: target.body,
          model: target.model,
          reason: input.reason,
          authorEmail: input.authorEmail,
          isActive: true,
          examples: (target.examples ?? Prisma.DbNull) as Prisma.InputJsonValue,
        },
      });
    });
  } catch (error) {
    translateVersionConflict(error);
  }
}

export async function getPromptVersions(workspaceId: string) {
  const versions = await prisma.copywriterPrompt.findMany({
    where: { workspaceId },
    orderBy: { version: "desc" },
  });
  return {
    versions,
    active: versions.find((version) => version.isActive) ?? null,
  };
}

/* -------------------------------- metrics --------------------------------- */

export interface LabVersionMetrics {
  promptVersion: number;
  generations: number;
  lintPassFirstAttempt: number;
  repairRate: number;
  fallbackRate: number;
  acceptedWithoutEdit: number;
  medianEditDistance: number | null;
  medianLatencyMs: number | null;
  tierMix: Record<string, number>;
  enoughData: boolean;
}

interface LabMetricRow {
  promptVersion: number;
  generations: number | bigint;
  lintPassFirstAttempt: number | bigint;
  repairs: number | bigint;
  fallbacks: number | bigint;
  acceptedWithoutEdit: number | bigint;
  medianEditDistance: string | number | null;
  medianLatency: string | number | null;
  tierMix: unknown;
}

const numberFrom = (value: number | bigint | string | null | undefined) =>
  value === null || value === undefined ? null : Number(value);

/**
 * Pure projection of the aggregate rows onto the metrics the page renders.
 * Tests run this on a fixture; the query only bounds and groups.
 */
export function labMetricsFromRows(rows: LabMetricRow[]): LabVersionMetrics[] {
  return rows.map((row) => {
    const generations = Number(row.generations);
    const repairs = Number(row.repairs);
    const fallbacks = Number(row.fallbacks);
    const tierMix: Record<string, number> = {};
    if (isRecord(row.tierMix)) {
      for (const [tier, count] of Object.entries(row.tierMix)) {
        tierMix[tier] = Number(count);
      }
    }
    return {
      promptVersion: Number(row.promptVersion),
      generations,
      lintPassFirstAttempt: Number(row.lintPassFirstAttempt),
      repairRate: generations > 0 ? repairs / generations : 0,
      fallbackRate: generations > 0 ? fallbacks / generations : 0,
      acceptedWithoutEdit: Number(row.acceptedWithoutEdit),
      medianEditDistance: numberFrom(row.medianEditDistance),
      medianLatencyMs: numberFrom(row.medianLatency),
      tierMix,
      enoughData: generations >= METRICS_MIN_GENERATIONS,
    };
  });
}

/**
 * One bounded aggregate query per workspace: last 90 days, production rows
 * only (trials excluded), grouped by prompt version. A repaired generation
 * is TWO rows (the failed attempt + the repair): `generations` counts only
 * attempt-1 rows so one generation stays one generation, and `fallbacks`
 * excludes the LINT_REPAIR_QUEUED marker — a repaired generation never fell
 * back to the standard copy. Tier mix rides along as a correlated aggregate
 * so the whole read stays a single GROUP BY.
 */
export async function getLabMetrics(
  workspaceId: string,
  now = new Date()
): Promise<LabVersionMetrics[]> {
  const since = new Date(now.getTime() - METRICS_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const rows = await prisma.$queryRaw<LabMetricRow[]>`
    SELECT
      g."promptVersion" AS "promptVersion",
      COUNT(*) FILTER (WHERE g."attempt" = 1)::int AS "generations",
      COUNT(*) FILTER (WHERE g."attempt" = 1 AND g."status" = 'DONE')::int AS "lintPassFirstAttempt",
      COUNT(*) FILTER (WHERE g."attempt" > 1)::int AS "repairs",
      COUNT(*) FILTER (WHERE g."status" = 'FAILED' AND g."failureCode" IS DISTINCT FROM 'LINT_REPAIR_QUEUED')::int AS "fallbacks",
      COUNT(*) FILTER (WHERE g."editDistance" = 0)::int AS "acceptedWithoutEdit",
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY g."editDistance") AS "medianEditDistance",
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY g."latencyMs") AS "medianLatency",
      (
        SELECT COALESCE(jsonb_object_agg(t."tier", t."n"), '{}'::jsonb)
        FROM (
          SELECT t2."tier" AS "tier", COUNT(*)::int AS "n"
          FROM "CopyGeneration" t2
          WHERE t2."workspaceId" = ${workspaceId}
            AND t2."isTrial" = false
            AND t2."createdAt" >= ${since}
            AND t2."tier" IS NOT NULL
            AND t2."promptVersion" = g."promptVersion"
          GROUP BY t2."tier"
        ) t
      ) AS "tierMix"
    FROM "CopyGeneration" g
    WHERE g."workspaceId" = ${workspaceId}
      AND g."isTrial" = false
      AND g."createdAt" >= ${since}
    GROUP BY g."promptVersion"`;
  return labMetricsFromRows(rows);
}

/* ---------------------------- recent generations --------------------------- */

function factsFromInput(input: unknown): Record<string, unknown> {
  if (!isRecord(input) || !isRecord(input.facts)) return {};
  const facts = input.facts;
  const pick = (key: string) =>
    typeof facts[key] === "string" ? (facts[key] as string) : undefined;
  return {
    sku: pick("sku"),
    title: pick("title"),
    artists: Array.isArray(facts.artists) ? facts.artists : undefined,
    label: pick("label"),
    state: pick("state"),
  };
}

export function captionFromInput(input: unknown): string {
  return isRecord(input) && typeof input.caption === "string" ? input.caption : "";
}

/** Canonical identity of a generation input (facts + caption). */
export function inputKey(input: unknown): string {
  if (!isRecord(input)) return "";
  return canonicalJson({ facts: input.facts ?? null, caption: input.caption ?? null });
}

export async function getRecentGenerations(workspaceId: string, limit = 20) {
  const rows = await prisma.copyGeneration.findMany({
    where: { workspaceId, isTrial: false },
    orderBy: { createdAt: "desc" },
    take: Math.max(1, Math.min(Math.floor(limit) || 20, 50)),
  });
  // Campaign names join in one bounded read; a generation whose campaign was
  // deleted simply carries no name.
  const automationIds = [
    ...new Set(rows.map((row) => row.automationId).filter((id): id is string => !!id)),
  ];
  const campaigns = automationIds.length
    ? await prisma.automation.findMany({
        where: { workspaceId, id: { in: automationIds } },
        select: { id: true, name: true },
      })
    : [];
  const campaignNames = new Map(campaigns.map((c) => [c.id, c.name]));
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt,
    status: row.status,
    attempt: row.attempt,
    promptVersion: row.promptVersion,
    tier: row.tier,
    latencyMs: row.latencyMs,
    failureCode: row.failureCode,
    editDistance: row.editDistance,
    hasFinalCopy: row.finalCopy !== null,
    lintErrors: row.lintErrors,
    output: row.output,
    finalCopy: row.finalCopy,
    input: row.input,
    renderedPrompt: row.renderedPrompt,
    facts: factsFromInput(row.input),
    caption: captionFromInput(row.input),
    campaignId: row.automationId,
    campaignName: row.automationId
      ? campaignNames.get(row.automationId) ?? null
      : null,
  }));
}

/* ----------------------------- golden examples ----------------------------- */

const EXAMPLE_FACT_KEYS = ["sku", "title", "artists", "label", "state"] as const;

/**
 * A golden example block, in the exact format the {{examples}} placeholder
 * renders: "FACTS {json} → OUTPUT {json}".
 */
export function exampleBlock(facts: unknown, copy: CopyTexts): string {
  const block: Record<string, unknown> = {};
  if (isRecord(facts)) {
    for (const key of EXAMPLE_FACT_KEYS) {
      if (facts[key] !== undefined && facts[key] !== null && facts[key] !== "") {
        block[key] = facts[key];
      }
    }
  }
  return `FACTS ${JSON.stringify(block)} → OUTPUT ${JSON.stringify({
    openingDm: copy.openingDm,
    openingButton: copy.openingButton,
    revealDm: copy.revealDm,
    linkButton: copy.linkButton,
  })}`;
}

/**
 * Build an example from a generation the team validated. Refuses anything
 * without a `finalCopy`: an example is the human-validated copy, never the
 * raw model output.
 */
export async function makeExampleFromGeneration(
  workspaceId: string,
  generationId: string
): Promise<string> {
  const row = await prisma.copyGeneration.findFirst({
    where: { id: generationId, workspaceId },
  });
  if (!row) throw new CopywriterError("NOT_FOUND", 404);
  const copy = row.finalCopy;
  if (!isRecord(copy)) throw new CopywriterError("NO_FINAL_COPY", 400);
  const texts: CopyTexts = {
    openingDm: typeof copy.openingDm === "string" ? copy.openingDm : null,
    openingButton: typeof copy.openingButton === "string" ? copy.openingButton : null,
    revealDm: typeof copy.revealDm === "string" ? copy.revealDm : "",
    linkButton: typeof copy.linkButton === "string" ? copy.linkButton : "",
  };
  if (!texts.revealDm || !texts.linkButton) {
    throw new CopywriterError("NO_FINAL_COPY", 400);
  }
  return exampleBlock(factsFromInput(row.input), texts);
}

/**
 * Build an example from a campaign picked by name or SKU search. The FACTS
 * side is limited to what a campaign row actually stores (SKU tag, name).
 */
export function exampleFromCampaign(automation: {
  name: string;
  catnoTag: string | null;
  openingDmMessage: string | null;
  openingDmButtonLabel: string | null;
  dmMessage: string | null;
  linkButtonLabel: string | null;
}): string {
  return exampleBlock(
    { sku: automation.catnoTag ?? undefined, title: automation.name },
    {
      openingDm: automation.openingDmMessage,
      openingButton: automation.openingDmButtonLabel,
      revealDm: automation.dmMessage ?? "",
      linkButton: automation.linkButtonLabel ?? "",
    }
  );
}

export async function searchCampaignsForExamples(workspaceId: string, query: string) {
  const q = query.trim();
  if (q.length < 2) return [];
  return prisma.automation.findMany({
    where: {
      workspaceId,
      lifecycle: { not: "ARCHIVED" },
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { catnoTag: { contains: q, mode: "insensitive" } },
      ],
    },
    select: {
      id: true,
      name: true,
      catnoTag: true,
      openingDmMessage: true,
      openingDmButtonLabel: true,
      dmMessage: true,
      linkButtonLabel: true,
      isActive: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
}

/**
 * Append a golden example by creating a NEW active version with the same
 * body — the examples live on the version, so metrics stay attributable.
 * The cap of 3 is enforced here. An identical example is a no-op.
 */
export async function addGoldenExample(
  workspaceId: string,
  block: string,
  authorEmail: string
) {
  const active = await ensureActivePrompt(workspaceId);
  const current = readExamplesJson(active.examples);
  if (current.includes(block)) {
    return { prompt: active, examples: current, added: false };
  }
  if (current.length >= EXAMPLES_CAP) {
    throw new CopywriterError("EXAMPLES_CAP_REACHED", 400);
  }
  if (block.length > EXAMPLE_MAX_LENGTH) {
    throw new CopywriterError("EXAMPLE_TOO_LONG", 400);
  }
  const prompt = await createPromptVersion({
    workspaceId,
    body: active.body,
    model: active.model,
    reason: `Add golden example (${current.length + 1}/${EXAMPLES_CAP})`,
    authorEmail,
    examples: [...current, block],
    // A concurrent version change (another owner editing/reverting) must not
    // be silently clobbered by an example operation.
    expectedActiveId: active.id,
    activate: true,
  });
  return { prompt, examples: [...current, block], added: true };
}

export async function removeGoldenExample(
  workspaceId: string,
  index: number,
  authorEmail: string
) {
  const active = await ensureActivePrompt(workspaceId);
  const current = readExamplesJson(active.examples);
  if (index < 0 || index >= current.length) {
    throw new CopywriterError("NOT_FOUND", 404);
  }
  const next = current.filter((_, i) => i !== index);
  const prompt = await createPromptVersion({
    workspaceId,
    body: active.body,
    model: active.model,
    reason: `Remove golden example (${current.length - 1}/${EXAMPLES_CAP} left)`,
    authorEmail,
    examples: next,
    expectedActiveId: active.id,
    activate: true,
  });
  return { prompt, examples: next };
}

/* --------------------------------- trials --------------------------------- */

export interface TrialRunResult {
  ids: string[];
}

/**
 * Enqueue one trial run: up to 5 generations, one per recent distinct input,
 * rendered from the DRAFT body. Rows are `isTrial` from birth: no
 * automationId, no auto-apply, excluded from production metrics. A second
 * concurrent run per workspace is refused — trials spend the same shared
 * subscription quota as production generations.
 */
export async function createTrialRun(input: {
  workspaceId: string;
  body: string;
  model: string;
  authorEmail: string;
}): Promise<TrialRunResult> {
  assertValidPromptBody(input.body);
  assertValidLabModel(input.model);

  const active = await ensureActivePrompt(input.workspaceId);
  const recent = await prisma.copyGeneration.findMany({
    where: { workspaceId: input.workspaceId, isTrial: false },
    orderBy: { createdAt: "desc" },
    take: TRIAL_SOURCE_SCAN,
  });
  const seen = new Set<string>();
  const sources: typeof recent = [];
  for (const row of recent) {
    // A row without a facts record cannot render a meaningful draft prompt:
    // skip it rather than queue a generation built on a fake shape.
    if (!isRecord(row.input) || !isRecord(row.input.facts)) continue;
    const key = inputKey(row.input);
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push(row);
    if (sources.length === TRIAL_RUN_SIZE) break;
  }
  if (sources.length === 0) {
    throw new CopywriterError("NO_TRIAL_INPUTS", 409);
  }

  // One run per workspace at a time. The advisory lock makes the
  // in-flight check and the inserts atomic: two owners clicking "Test"
  // together cannot both pass the count and burn twice the shared quota.
  const examples = readExamplesJson(active.examples);
  const bodyHash = draftHash(input.body, examples);
  const ids = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${input.workspaceId}))`;
    const running = await tx.copyGeneration.count({
      where: {
        workspaceId: input.workspaceId,
        isTrial: true,
        status: { in: ["PENDING", "CLAIMED"] },
      },
    });
    if (running > 0) throw new CopywriterError("TRIAL_IN_PROGRESS", 409);
    return Promise.all(
      sources.map((source) => {
        const facts =
          isRecord(source.input) && isRecord(source.input.facts)
            ? source.input.facts
            : { description: "" };
        return tx.copyGeneration.create({
          data: {
            workspaceId: input.workspaceId,
            // Trials never touch a campaign.
            automationId: null,
            autoApply: false,
            isTrial: true,
            promptId: active.id,
            promptVersion: active.version,
            // The draft runs on the DRAFT model, and the trial is bound to
            // this exact body so it can never vouch for a different draft.
            modelOverride: input.model,
            trialBodyHash: bodyHash,
            input: source.input as Prisma.InputJsonValue,
            renderedPrompt: renderPrompt(
              input.body,
              facts as never,
              captionFromInput(source.input),
              { examples }
            ),
            standardCopy: source.standardCopy as Prisma.InputJsonValue,
          },
          select: { id: true },
        });
      })
    );
  });
  return { ids: ids.map((row) => row.id) };
}

export interface TrialItemStatus {
  id: string;
  /** The id actually carrying the outcome (the repair row, when one ran). */
  effectiveId: string;
  status: "PENDING" | "CLAIMED" | "DONE" | "FAILED";
  lintOk: boolean;
  lintErrors: unknown;
  output: unknown;
  tier: string | null;
  latencyMs: number | null;
  promptVersion: number;
  baseline: {
    generationId: string;
    promptVersion: number;
    status: string;
    output: unknown;
  } | null;
  input: unknown;
}

/** Follow the repair link the way the assistant status route does. */
async function effectiveOutcome(workspaceId: string, row: {
  id: string;
  status: string;
  failureCode: string | null;
}) {
  if (row.status === "FAILED" && row.failureCode === "LINT_REPAIR_QUEUED") {
    const repair = await prisma.copyGeneration.findFirst({
      where: { sourceGenerationId: row.id, workspaceId },
      orderBy: { createdAt: "desc" },
    });
    if (repair) return repair;
  }
  return null;
}

/**
 * Trial results for the lab screen: each trial's effective outcome, its lint
 * status, and the most recent production output for the same input as the
 * side-by-side baseline.
 */
export async function getTrialResults(
  workspaceId: string,
  ids: string[]
): Promise<TrialItemStatus[]> {
  if (ids.length === 0 || ids.length > TRIAL_RUN_SIZE) {
    throw new CopywriterError("INVALID_TRIAL_IDS", 400);
  }
  const rows = await prisma.copyGeneration.findMany({
    where: { workspaceId, id: { in: ids }, isTrial: true },
    orderBy: { createdAt: "asc" },
  });

  // One bounded tail read serves every baseline: the comparison the docs
  // promise is the ACTIVE version's outcome for the same input. The tail is
  // newest-first and the map keeps the FIRST hit per input, so the baseline
  // is the MOST RECENT production row for that input. A baseline that
  // queued its repair is judged on the repair's outcome, exactly like the
  // trial side — otherwise the gate would be biased in the draft's favour.
  const active = await ensureActivePrompt(workspaceId);
  const tail = await prisma.copyGeneration.findMany({
    where: { workspaceId, isTrial: false, promptVersion: active.version },
    orderBy: { createdAt: "desc" },
    take: TRIAL_SOURCE_SCAN,
  });
  const tailByKey = new Map<string, (typeof tail)[number]>();
  for (const row of tail) {
    const key = inputKey(row.input);
    if (!tailByKey.has(key)) tailByKey.set(key, row);
  }

  const items: TrialItemStatus[] = [];
  for (const row of rows) {
    const effective = (await effectiveOutcome(workspaceId, row)) ?? row;
    const source = tailByKey.get(inputKey(row.input));
    const baselineOutcome = source
      ? (await effectiveOutcome(workspaceId, source)) ?? source
      : null;
    // A baseline is comparable only when its outcome is TERMINAL: DONE, or
    // FAILED for a reason that is not a queued repair. PENDING/CLAIMED rows
    // and repairs still in flight say nothing about the active version.
    const baselineTerminal =
      baselineOutcome !== null &&
      (baselineOutcome.status === "DONE" ||
        (baselineOutcome.status === "FAILED" &&
          baselineOutcome.failureCode !== "LINT_REPAIR_QUEUED"));
    items.push({
      id: row.id,
      effectiveId: effective.id,
      status: effective.status as TrialItemStatus["status"],
      lintOk: effective.status === "DONE",
      lintErrors: effective.lintErrors,
      output: effective.output,
      tier: effective.tier,
      latencyMs: effective.latencyMs,
      promptVersion: row.promptVersion,
      baseline: baselineTerminal
        ? {
            generationId: baselineOutcome.id,
            promptVersion: baselineOutcome.promptVersion,
            status: baselineOutcome.status,
            output: baselineOutcome.output,
          }
        : null,
      input: row.input,
    });
  }
  return items;
}

export interface TrialVerdict {
  /** Every requested id resolved to a finished trial row. */
  ready: boolean;
  /** Draft passes over ALL trial inputs (display). */
  trialPass: number;
  /** Active-version passes over the comparable inputs (display). */
  baselinePass: number;
  /** Draft passes over the comparable inputs (the gate's own number). */
  comparablePass: number;
  /** Inputs that actually had an active-version baseline to compare with. */
  baselinesFound: number;
  gateOk: boolean;
}

/**
 * The activation gate: over the trial inputs that HAVE an active-version
 * baseline, the draft's lint pass must be at least as good as the active
 * version's — and there must BE such a baseline to compare with. A freshly
 * activated version with no production rows yet gives no baseline: the gate
 * refuses rather than passing for free (the override records that decision).
 */
export function verdictFromItems(items: TrialItemStatus[]): TrialVerdict {
  if (items.length === 0) {
    throw new CopywriterError("NOT_FOUND", 404);
  }
  const finished = items.every((item) => item.status === "DONE" || item.status === "FAILED");
  // The comparison set: inputs where the active version actually produced
  // an outcome. Counting the draft's passes over a wider set than the
  // baseline's would let a mostly-failed draft ride one lucky input.
  const comparable = items.filter((item) => item.baseline !== null);
  const trialPass = items.filter((item) => item.lintOk).length;
  const comparablePass = comparable.filter((item) => item.lintOk).length;
  const baselinePass = comparable.filter(
    (item) => item.baseline && item.baseline.status === "DONE"
  ).length;
  return {
    ready: finished,
    trialPass,
    baselinePass,
    comparablePass,
    baselinesFound: comparable.length,
    gateOk:
      finished &&
      comparable.length >= GATE_MIN_COMPARABLE_BASELINES &&
      comparablePass >= baselinePass,
  };
}

export async function trialVerdict(
  workspaceId: string,
  ids: string[]
): Promise<TrialVerdict> {
  return verdictFromItems(await getTrialResults(workspaceId, ids));
}

/* ------------------------------- activation ------------------------------- */

export interface ActivateDraftInput {
  workspaceId: string;
  body: string;
  model: string;
  reason: string;
  authorEmail: string;
  examples?: readonly string[];
  trialIds?: string[];
  activateAnyway?: boolean;
}

const OVERRIDE_MARKER = " [activation override]";

/**
 * Create version N+1 from the draft and flip it active in one transaction.
 * Without the explicit override, the gate demands a trial run OF THIS EXACT
 * DRAFT (same body hash, same model) whose lint pass is at least as good as
 * the active version's on the same inputs — a trial can never vouch for a
 * different body. Using the override is recorded in the reason. Golden
 * examples carry over from the active version unless explicitly replaced,
 * so activation never silently drops them.
 */
export async function activateDraft(input: ActivateDraftInput) {
  const active = await ensureActivePrompt(input.workspaceId);
  const examples = input.examples ?? readExamplesJson(active.examples);
  const bodyHash = draftHash(input.body, examples);
  if (!input.activateAnyway) {
    if (!input.trialIds?.length) {
      throw new CopywriterError("ACTIVATION_GATE_FAILED", 409);
    }
    // The trial ids must cover the WHOLE most recent run of this exact
    // draft (same body hash, same model): a cherry-picked subset of passing
    // ids can never satisfy the gate for a run that mostly failed. Only
    // ROOT rows count — repair rows belong to their root's outcome, and
    // counting them would make every repaired run "6 rows" and impossible
    // to cover with the 5-id cap.
    const runWindow = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const runRoots = await prisma.copyGeneration.findMany({
      where: {
        workspaceId: input.workspaceId,
        isTrial: true,
        trialBodyHash: bodyHash,
        modelOverride: input.model,
        sourceGenerationId: null,
        createdAt: { gte: runWindow },
      },
      select: { id: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });
    if (runRoots.length === 0) {
      throw new CopywriterError("ACTIVATION_GATE_FAILED", 409);
    }
    // A run's 5 roots are inserted in ONE transaction, so Postgres stamps
    // them with the same transaction timestamp (CURRENT_TIMESTAMP is the
    // tx start). The run being activated is the newest such batch — a
    // re-test hours (or minutes) later is its own batch, never a merge.
    const newestAt = runRoots[0].createdAt.getTime();
    const BATCH_TOLERANCE_MS = 1000;
    const runIds = runRoots
      .filter((row) => Math.abs(newestAt - row.createdAt.getTime()) <= BATCH_TOLERANCE_MS)
      .map((row) => row.id);
    const submitted = new Set(input.trialIds);
    const coversRun =
      submitted.size === input.trialIds.length &&
      runIds.every((id) => submitted.has(id)) &&
      input.trialIds.length === runIds.length;
    if (!coversRun) {
      throw new CopywriterError("ACTIVATION_GATE_FAILED", 409);
    }
    const verdict = await trialVerdict(input.workspaceId, input.trialIds);
    if (!verdict.gateOk) {
      throw new CopywriterError("ACTIVATION_GATE_FAILED", 409);
    }
  }
  const reason = input.activateAnyway
    ? `${input.reason}${OVERRIDE_MARKER}`
    : input.reason;
  return createPromptVersion({
    workspaceId: input.workspaceId,
    body: input.body,
    model: input.model,
    reason,
    authorEmail: input.authorEmail,
    examples,
    // The verdict above was computed against THIS active version; if
    // another owner activated or reverted in between, refuse instead of
    // silently replacing a version the draft was never compared to.
    expectedActiveId: active.id,
    activate: true,
  });
}
