import { readFileSync } from "node:fs";
import path from "node:path";
import { Prisma } from "@/app/generated/prisma/client";
import { z } from "zod";
import { lintGeneratedCopy } from "@/lib/copy/copy-linter";
import type { CampaignCopy } from "@/lib/copy/yoyaku-patterns";
import type { LintViolation } from "@/lib/copy/copy-linter";
import { releaseFactsFrom } from "@/lib/assistant/generate-copy";
import type { ProductFacts } from "@/lib/assistant/resolve-product";
import { copyEditDistance, type CopyTexts } from "@/lib/copywriter/edit-distance";
import { prisma } from "@/lib/db/client";
import { sanitizeFailureCode } from "@/lib/sav/security";

/**
 * The AI copywriter queue, app side (the SAV bridge pattern).
 *
 * The app renders the prompt from the active `CopywriterPrompt` and queues a
 * `CopyGeneration`; the host worker claims it over the loopback-only internal
 * API, calls the subscription cascade, and posts raw JSON back. Every failure
 * path keeps the standard copy — the AI never blocks a campaign:
 *
 *   zod → lintGeneratedCopy → OK: DONE
 *                            → errors on attempt 1: one repair attempt (PENDING)
 *                            → errors on attempt 2: FAILED, standard copy kept
 */

const LEASE_MS = 60 * 1000;
const CLAIM_TIMEOUT_SEC = 45;
export const MAX_CLAIM_LIMIT = 5;
/** A row that keeps losing its worker is failed, not retried forever. */
export const MAX_CLAIM_ATTEMPTS = 3;
const TEXT_BLOCK_MAX_LENGTH = 1200;
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const REPAIR_OUTPUT_MAX_LENGTH = 1200;

const SEED_VERSION = 1;
const SEED_MODEL = "haiku";
const SEED_AUTHOR_EMAIL = "seed@openreply";
const SEED_REASON = "v1 seed from lib/assistant/prompts/caption-to-dm.v1.md";
const SEED_PROMPT_FILE = "caption-to-dm.v1.md";

/** Stable failure codes shared with the worker contract and the docs. */
export const FAILURE_CODES = {
  LINT_REPAIR_QUEUED: "LINT_REPAIR_QUEUED",
  LINT_FAILED: "LINT_FAILED",
  CASCADE_FAILED: "CASCADE_FAILED",
  WORKER_FAILED: "WORKER_FAILED",
} as const;

/** Strict shape the cascade must return (delivered in the claim payload). */
export const COPY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["openingDm", "openingButton", "revealDm", "linkButton"],
  properties: {
    openingDm: { type: "string", minLength: 1, maxLength: 160 },
    openingButton: { type: "string", minLength: 1, maxLength: 20 },
    revealDm: { type: "string", minLength: 1, maxLength: 280 },
    linkButton: { type: "string", minLength: 1, maxLength: 20 },
  },
} as const;

/** Mirrors COPY_SCHEMA; the app is the authority on validation. */
const copyOutputSchema = z.object({
  openingDm: z.string().min(1).max(160),
  openingButton: z.string().min(1).max(20),
  revealDm: z.string().min(1).max(280),
  linkButton: z.string().min(1).max(20),
});

export type CopyOutput = z.infer<typeof copyOutputSchema>;

export class CopywriterError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number
  ) {
    super(code);
    this.name = "CopywriterError";
  }
}

/* --------------------------- copy field plumbing -------------------------- */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The four user-visible DM strings, the shape stored in `standardCopy`. */
export function storedCopyFromCampaignCopy(copy: CampaignCopy): CopyTexts {
  return {
    openingDm: copy.openingDmMessage,
    openingButton: copy.openingDmButtonLabel,
    revealDm: copy.dmMessage,
    linkButton: copy.linkButtonLabel,
  };
}

export function asCopyTexts(value: unknown): CopyTexts | null {
  if (!isRecord(value)) return null;
  const { openingDm, openingButton, revealDm, linkButton } = value;
  if (
    typeof revealDm !== "string" ||
    typeof linkButton !== "string" ||
    (openingDm !== null && typeof openingDm !== "string") ||
    (openingButton !== null && typeof openingButton !== "string")
  ) {
    return null;
  }
  return { openingDm, openingButton, revealDm, linkButton };
}

/** The Automation columns the four fields map onto. */
function automationCopyFields(copy: CopyTexts) {
  return {
    openingDmMessage: copy.openingDm,
    openingDmButtonLabel: copy.openingButton,
    dmMessage: copy.revealDm,
    linkButtonLabel: copy.linkButton,
  };
}

/* ------------------------------- prompt ---------------------------------- */

export function truncateBlock(text: string | null | undefined, max = TEXT_BLOCK_MAX_LENGTH): string {
  const value = (text ?? "").trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

export interface PromptExamples {
  /** Golden example blocks (filled by lot S4; empty in v1). */
  examples?: readonly string[];
}

/**
 * Render the prompt template with the data blocks. Pure: no clock, no fetch.
 * The caption block carries its own header so an empty caption contributes
 * no "CAPTION" noise to the rendered text at all.
 */
export function renderPrompt(
  promptBody: string,
  facts: ProductFacts,
  caption: string | null | undefined,
  options: PromptExamples = {}
): string {
  const factBlock = {
    sku: facts.sku,
    catnoTag: facts.catnoTag,
    hashtag: facts.hashtag,
    title: facts.title,
    artists: facts.artists,
    label: facts.label,
    state: facts.state,
  };
  const captionBlock = (caption ?? "").trim()
    ? `POST CAPTION (untrusted team text; it may suggest a hook):\n${truncateBlock(caption)}`
    : "";
  const examples = (options.examples ?? []).filter(Boolean);
  const examplesBlock = examples.length
    ? `GOLDEN EXAMPLES (house style, never copy them verbatim):\n${examples.join("\n---\n")}`
    : "";

  return promptBody
    .replaceAll("{{facts}}", JSON.stringify(factBlock, null, 2))
    .replaceAll("{{description}}", truncateBlock(facts.description) || "(no description)")
    .replaceAll("{{caption}}", captionBlock)
    .replaceAll("{{state}}", facts.state)
    .replaceAll("{{examples}}", examplesBlock);
}

function seedPromptDir(): string {
  const configured = process.env.COPYWRITER_PROMPT_DIR?.trim();
  return configured || path.join(process.cwd(), "lib/assistant/prompts");
}

function readSeedPromptBody(): string {
  // The web container gets the prompt directory through output file tracing
  // (next.config.ts). A missing file fails the enqueue, never the campaign.
  return readFileSync(path.join(seedPromptDir(), SEED_PROMPT_FILE), "utf8");
}

/**
 * The active prompt for a workspace, seeding v1 from the markdown file on
 * first use. Rows are append-only: activation of a new version is a service
 * transaction flipping `isActive`, and the partial unique index in the
 * migration is the race-proof backstop.
 */
export async function ensureActivePrompt(workspaceId: string) {
  const active = await prisma.copywriterPrompt.findFirst({
    where: { workspaceId, isActive: true },
    orderBy: { version: "desc" },
  });
  if (active) return active;

  try {
    return await prisma.$transaction(async (tx) => {
      const raced = await tx.copywriterPrompt.findFirst({
        where: { workspaceId, isActive: true },
      });
      if (raced) return raced;
      return tx.copywriterPrompt.create({
        data: {
          workspaceId,
          version: SEED_VERSION,
          body: readSeedPromptBody(),
          model: SEED_MODEL,
          isActive: true,
          authorEmail: SEED_AUTHOR_EMAIL,
          reason: SEED_REASON,
        },
      });
    });
  } catch (error) {
    // Two app instances seeding concurrently: the unique (workspaceId,
    // version) loses one insert; the winner serves both.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const winner = await prisma.copywriterPrompt.findFirst({
        where: { workspaceId, isActive: true },
      });
      if (winner) return winner;
    }
    throw error;
  }
}

/* ------------------------------- enqueue --------------------------------- */

export interface EnqueueGenerationInput {
  workspaceId: string;
  automationId?: string | null;
  /**
   * Release sync only: the DONE result may auto-apply to the campaign while
   * the guards hold. Assistant rows must never auto-apply — recording
   * automationId on save would otherwise re-arm the applier over the copy
   * the team just validated.
   */
  autoApply?: boolean;
  facts: ProductFacts;
  caption?: string | null;
  standardCopy: CopyTexts;
}

/**
 * Queue one AI copy generation. Returns the generation id, or null when the
 * copywriter is disabled or anything fails — callers never wait and never
 * block a campaign on the AI.
 */
const DEDUPE_WINDOW_MS = 60 * 1000;

/**
 * A recent equivalent row for the same product within the dedupe window:
 * repeated Prepare or Regenerate clicks must not stack paid cascade calls
 * for the exact same request. Identity = workspace, automation target,
 * product SKU, caption and standard copy all equal.
 */
async function findRecentEquivalentRow(
  workspaceId: string,
  input: EnqueueGenerationInput,
  promptId: string,
  now: Date
): Promise<{ id: string } | null> {
  const recent = await prisma.copyGeneration.findFirst({
    where: {
      workspaceId,
      promptId,
      status: { in: ["PENDING", "CLAIMED"] },
      createdAt: { gte: new Date(now.getTime() - DEDUPE_WINDOW_MS) },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!recent) return null;
  if ((recent.automationId ?? null) !== (input.automationId ?? null)) return null;
  if (recent.autoApply !== (input.autoApply ?? false)) return null;
  if (!isRecord(recent.input)) return null;
  const recentFacts = recent.input.facts;
  const recentCaption = typeof recent.input.caption === "string" ? recent.input.caption : "";
  if (
    !isRecord(recentFacts) ||
    recentFacts.sku !== input.facts.sku ||
    recentCaption !== truncateBlock(input.caption)
  ) {
    return null;
  }
  return { id: recent.id };
}

export async function enqueueGeneration(
  input: EnqueueGenerationInput
): Promise<string | null> {
  if (process.env.COPYWRITER_ENABLED !== "true") return null;

  try {
    const prompt = await ensureActivePrompt(input.workspaceId);
    const duplicate = await findRecentEquivalentRow(
      input.workspaceId,
      input,
      prompt.id,
      new Date()
    );
    if (duplicate) return duplicate.id;
    const row = await prisma.copyGeneration.create({
      data: {
        workspaceId: input.workspaceId,
        automationId: input.automationId ?? null,
        autoApply: input.autoApply ?? false,
        promptId: prompt.id,
        promptVersion: prompt.version,
        input: {
          facts: input.facts as unknown as Prisma.InputJsonValue,
          caption: truncateBlock(input.caption),
        },
        renderedPrompt: renderPrompt(prompt.body, input.facts, input.caption),
        standardCopy: input.standardCopy as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return row.id;
  } catch (error) {
    console.error("[copywriter] enqueue failed; standard copy stays", error);
    return null;
  }
}

/* -------------------------------- claim ---------------------------------- */

export interface ClaimedCopyItem {
  id: string;
  renderedPrompt: string;
  jsonSchema: typeof COPY_SCHEMA;
  model: string;
  timeoutSec: number;
}

/**
 * Lease up to `limit` rows (PENDING, or CLAIMED with an expired lease).
 * The SELECT ... FOR UPDATE SKIP LOCKED inside one transaction is the
 * multi-worker guard: a second worker cannot lease the same row.
 */
export async function claimCopyItems(
  workerId: string,
  requestedLimit: number
): Promise<ClaimedCopyItem[]> {
  const limit = Math.max(
    1,
    Math.min(Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 1, MAX_CLAIM_LIMIT)
  );
  const now = new Date();

  const claimedIds = await prisma.$transaction(async (tx) => {
    const candidates = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "CopyGeneration"
      WHERE "status" = 'PENDING'
         OR ("status" = 'CLAIMED' AND "leaseExpiresAt" <= ${now})
      ORDER BY "createdAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED`;

    const claimed: string[] = [];
    for (const candidate of candidates) {
      // A poisoned item (worker crash loop, unreachable app) must not burn
      // cascade quota forever: past the cap the row is terminal.
      const stuck = await tx.copyGeneration.updateMany({
        where: {
          id: candidate.id,
          claimAttempts: { gte: MAX_CLAIM_ATTEMPTS },
          OR: [
            { status: "PENDING" },
            { status: "CLAIMED", leaseExpiresAt: { lte: now } },
          ],
        },
        data: {
          status: "FAILED",
          failureCode: "CLAIM_ATTEMPTS_EXHAUSTED",
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      });
      if (stuck.count === 1) continue;
      const updated = await tx.copyGeneration.updateMany({
        where: {
          id: candidate.id,
          claimAttempts: { lt: MAX_CLAIM_ATTEMPTS },
          OR: [
            { status: "PENDING" },
            { status: "CLAIMED", leaseExpiresAt: { lte: now } },
          ],
        },
        data: {
          status: "CLAIMED",
          leaseOwner: workerId,
          leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
          claimAttempts: { increment: 1 },
        },
      });
      if (updated.count === 1) claimed.push(candidate.id);
    }
    return claimed;
  });

  if (claimedIds.length === 0) return [];

  const rows = await prisma.copyGeneration.findMany({
    where: { id: { in: claimedIds } },
    include: { prompt: { select: { model: true } } },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((row) => ({
    id: row.id,
    renderedPrompt: row.renderedPrompt,
    jsonSchema: COPY_SCHEMA,
    model: row.prompt.model,
    timeoutSec: CLAIM_TIMEOUT_SEC,
  }));
}

/* ------------------------------ validation -------------------------------- */

/**
 * Pull the first complete JSON object out of a raw model answer. Models add
 * prose around the payload; cascade tiers without schema support may too.
 */
export function extractFirstJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function campaignCopyFromOutput(output: CopyOutput): CampaignCopy {
  // The linter reads the message and button fields only; name, goal and the
  // destination are campaign-level and never come from the model.
  return {
    name: "",
    goal: "",
    openingDmMessage: output.openingDm,
    openingDmButtonLabel: output.openingButton,
    dmMessage: output.revealDm,
    linkButtonLabel: output.linkButton,
    trackedDestinationUrl: "",
  };
}

interface GenerationInputPayload {
  facts: ProductFacts;
  caption: string | null;
}

function readGenerationInput(row: { input: unknown }): GenerationInputPayload {
  if (isRecord(row.input) && isRecord(row.input.facts)) {
    return {
      facts: row.input.facts as unknown as ProductFacts,
      caption: typeof row.input.caption === "string" ? row.input.caption : null,
    };
  }
  return { facts: { description: "" } as unknown as ProductFacts, caption: null };
}

/** Deterministic appendix the repair attempt receives. */
export function repairAppendix(
  violations: LintViolation[],
  previousOutput: string
): string {
  const lines = violations.map((v) => `- ${v.rule}: ${v.detail}`);
  return [
    "",
    "FIX THE PREVIOUS ANSWER",
    "Your previous answer failed these checks:",
    ...lines,
    "",
    "Previous answer (raw):",
    truncateBlock(previousOutput, REPAIR_OUTPUT_MAX_LENGTH),
    "",
    "Produce a new JSON object that passes every check. JSON only.",
  ].join("\n");
}

function validateOutput(
  row: { input: unknown },
  rawOutput: string
): { output?: CopyOutput; violations: LintViolation[] } {
  const extracted = extractFirstJsonObject(rawOutput);
  const normalized = isRecord(extracted)
    ? {
        openingDm: typeof extracted.openingDm === "string" ? extracted.openingDm.trim() : "",
        openingButton:
          typeof extracted.openingButton === "string" ? extracted.openingButton.trim() : "",
        revealDm: typeof extracted.revealDm === "string" ? extracted.revealDm.trim() : "",
        linkButton: typeof extracted.linkButton === "string" ? extracted.linkButton.trim() : "",
      }
    : null;
  const parsed = normalized ? copyOutputSchema.safeParse(normalized) : null;
  if (!parsed?.success) {
    return {
      violations: [
        {
          rule: "invalid-json",
          detail:
            "the answer must be one JSON object with openingDm, openingButton, revealDm and linkButton strings",
        },
      ],
    };
  }

  const { facts, caption } = readGenerationInput(row);
  const sourceText = [facts.description, caption].filter(Boolean).join("\n");
  const lint = lintGeneratedCopy(
    campaignCopyFromOutput(parsed.data),
    releaseFactsFrom(facts),
    { sourceText }
  );
  return { output: parsed.data, violations: lint.violations };
}

/* ----------------------------- result / fail ------------------------------ */

/**
 * The write must still belong to a live lease: a worker whose lease expired
 * between the check and the write must not finish a row another worker may
 * already own (a duplicate repair row would be the visible damage).
 */
async function writeUnderLease(
  id: string,
  workerId: string,
  data: Prisma.CopyGenerationUpdateManyMutationInput
): Promise<boolean> {
  const result = await prisma.copyGeneration.updateMany({
    where: {
      id,
      status: "CLAIMED",
      leaseOwner: workerId,
      leaseExpiresAt: { gt: new Date() },
    },
    data,
  });
  return result.count === 1;
}

async function requireLeaseHolder(id: string, workerId: string) {
  const row = await prisma.copyGeneration.findUnique({ where: { id } });
  if (!row) throw new CopywriterError("NOT_FOUND", 404);
  const leaseValid =
    row.status === "CLAIMED" &&
    row.leaseOwner === workerId &&
    row.leaseExpiresAt !== null &&
    row.leaseExpiresAt > new Date();
  if (!leaseValid) throw new CopywriterError("INVALID_LEASE", 409);
  return row;
}

export interface SubmitResultPayload {
  rawOutput: string;
  tier: string | null;
  latencyMs: number | null;
}

export async function submitCopyResult(
  id: string,
  workerId: string,
  payload: SubmitResultPayload
): Promise<{ status: "DONE" | "REPAIRED" | "FAILED" }> {
  const row = await requireLeaseHolder(id, workerId);
  const { violations, output } = validateOutput(row, payload.rawOutput);

  if (output && violations.length === 0) {
    const written = await writeUnderLease(id, workerId, {
      status: "DONE",
      output,
      rawOutput: payload.rawOutput,
      tier: payload.tier,
      latencyMs: payload.latencyMs,
      lintErrors: Prisma.DbNull,
      failureCode: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    if (!written) throw new CopywriterError("INVALID_LEASE", 409);
    // Release-sync rows carry the automation id AND the autoApply flag:
    // apply the AI copy while the guards hold. Assistant rows are applied
    // on save from the page — a save that records automationId must not
    // re-arm this applier over the copy the team just validated.
    if (row.autoApply && row.automationId) {
      await applyGenerationToAutomation(row.id);
    }
    return { status: "DONE" };
  }

  const terminalData = {
    lintErrors: violations as unknown as Prisma.InputJsonValue,
    rawOutput: payload.rawOutput,
    tier: payload.tier,
    latencyMs: payload.latencyMs,
    leaseOwner: null,
    leaseExpiresAt: null,
  };

  if (row.attempt <= 1) {
    // One repair attempt: a fresh PENDING row whose prompt carries the
    // linter messages and the previous answer. Attempt 1 itself is terminal.
    // The FAILED write and the repair create are one transaction: a DB blip
    // between them must not leave a row that promises a repair none exists.
    const written = await prisma.$transaction(async (tx) => {
      const marked = await tx.copyGeneration.updateMany({
        where: {
          id,
          status: "CLAIMED",
          leaseOwner: workerId,
          leaseExpiresAt: { gt: new Date() },
        },
        data: {
          status: "FAILED",
          failureCode: FAILURE_CODES.LINT_REPAIR_QUEUED,
          ...terminalData,
        },
      });
      if (marked.count !== 1) return false;
      await tx.copyGeneration.create({
        data: {
          workspaceId: row.workspaceId,
          automationId: row.automationId,
          autoApply: row.autoApply,
          // The precise back-link the status route follows.
          sourceGenerationId: row.id,
          promptId: row.promptId,
          promptVersion: row.promptVersion,
          input: row.input as Prisma.InputJsonValue,
          renderedPrompt: `${row.renderedPrompt}${repairAppendix(violations, payload.rawOutput)}`,
          attempt: row.attempt + 1,
          standardCopy: row.standardCopy as Prisma.InputJsonValue,
        },
      });
      return true;
    });
    if (!written) throw new CopywriterError("INVALID_LEASE", 409);
    return { status: "REPAIRED" };
  }

  const written = await writeUnderLease(id, workerId, {
    status: "FAILED",
    failureCode: FAILURE_CODES.LINT_FAILED,
    ...terminalData,
  });
  if (!written) throw new CopywriterError("INVALID_LEASE", 409);
  return { status: "FAILED" };
}

export async function submitCopyFailure(
  id: string,
  workerId: string,
  code: unknown
): Promise<void> {
  // The lease pre-check gives the precise 404 vs 409 code; the write itself
  // is lease-guarded, so an expired lease still cannot finish the row.
  await requireLeaseHolder(id, workerId);
  const written = await writeUnderLease(id, workerId, {
    status: "FAILED",
    failureCode: sanitizeFailureCode(code ?? FAILURE_CODES.WORKER_FAILED),
    leaseOwner: null,
    leaseExpiresAt: null,
  });
  if (!written) throw new CopywriterError("INVALID_LEASE", 409);
}

/* --------------------- release-sync apply (DONE guard) --------------------- */

export type ApplyOutcome =
  | "applied"
  | "skipped_no_automation"
  | "skipped_active"
  | "skipped_edited"
  | "skipped_no_output";

/**
 * Apply a DONE generation's copy to its release-sync campaign, only while
 * every guard holds: the campaign exists, is still inactive, and its four
 * copy fields still equal the stored standard copy (nobody edited it).
 * Activation stays human — this never flips `isActive`.
 */
export async function applyGenerationToAutomation(
  generationId: string
): Promise<ApplyOutcome> {
  const row = await prisma.copyGeneration.findUnique({
    where: { id: generationId },
  });
  const output = asCopyTexts(row?.output);
  if (!row || row.status !== "DONE" || !output) return "skipped_no_output";
  if (!row.automationId) return "skipped_no_automation";
  const standard = asCopyTexts(row.standardCopy);
  if (!standard) return "skipped_edited";

  // One guarded write IS the guard: untouched (all four fields still equal
  // the stored standard copy), still inactive, still in this workspace. An
  // operator activating or editing the campaign between an earlier read and
  // the write cannot be overwritten — the WHERE misses and nothing moves.
  const applied = await prisma.automation.updateMany({
    where: {
      id: row.automationId,
      workspaceId: row.workspaceId,
      isActive: false,
      openingDmMessage: standard.openingDm,
      openingDmButtonLabel: standard.openingButton,
      dmMessage: standard.revealDm,
      linkButtonLabel: standard.linkButton,
    },
    data: automationCopyFields(output),
  });
  if (applied.count !== 1) {
    // Classify only for the outcome code; the campaign is left untouched.
    const automation = await prisma.automation.findUnique({
      where: { id: row.automationId },
      select: { workspaceId: true, isActive: true },
    });
    if (!automation || automation.workspaceId !== row.workspaceId) {
      return "skipped_no_automation";
    }
    if (automation.isActive) return "skipped_active";
    return "skipped_edited";
  }
  await prisma.copyGeneration.update({
    where: { id: row.id },
    data: { appliedAt: new Date() },
  });
  return "applied";
}

/* ------------------------------ session side ------------------------------ */

export interface GenerationStatus {
  status: "PENDING" | "CLAIMED" | "DONE" | "FAILED";
  copy?: CopyOutput;
  lint?: LintViolation[];
  promptVersion: number;
  tier?: string;
  failureCode?: string;
}

function generationStatusFrom(row: {
  status: string;
  output: unknown;
  lintErrors: unknown;
  promptVersion: number;
  tier: string | null;
  failureCode: string | null;
}): GenerationStatus {
  const output = asCopyTexts(row.output);
  return {
    status: row.status as GenerationStatus["status"],
    copy: output
      ? {
          openingDm: output.openingDm ?? "",
          openingButton: output.openingButton ?? "",
          revealDm: output.revealDm,
          linkButton: output.linkButton,
        }
      : undefined,
    lint: Array.isArray(row.lintErrors)
      ? (row.lintErrors as unknown as LintViolation[])
      : undefined,
    promptVersion: row.promptVersion,
    tier: row.tier ?? undefined,
    failureCode: row.failureCode ?? undefined,
  };
}

/**
 * Workspace-scoped status read by the assistant page. The page polls the id
 * it received from prepare; when that attempt failed and queued its repair,
 * the status follows the repair row so a successful repair still reaches the
 * screen instead of falling back to the standard copy.
 */
export async function getGenerationStatus(
  id: string,
  workspaceId: string
): Promise<GenerationStatus | null> {
  const row = await prisma.copyGeneration.findUnique({ where: { id } });
  if (!row || row.workspaceId !== workspaceId) return null;

  if (
    row.status === "FAILED" &&
    row.failureCode === FAILURE_CODES.LINT_REPAIR_QUEUED
  ) {
    // Follow the explicit back-link, never a heuristic: two products can
    // share a workspace and prompt, and a loose match would serve product
    // B's repair row to product A's screen.
    const repair = await prisma.copyGeneration.findFirst({
      where: { sourceGenerationId: row.id, workspaceId: row.workspaceId },
      orderBy: { createdAt: "desc" },
    });
    if (repair) return generationStatusFrom(repair);
  }
  return generationStatusFrom(row);
}

export interface RecordFinalCopyInput {
  automationId: string;
  finalCopy: CopyTexts;
}

/**
 * On save from the assistant: store what the team validated, the distance
 * from what the model wrote, and the campaign this generation landed on.
 * Feeds lot S4.
 */
export async function recordFinalCopy(
  id: string,
  workspaceId: string,
  input: RecordFinalCopyInput
): Promise<{ editDistance: number | null } | null> {
  const row = await prisma.copyGeneration.findUnique({ where: { id } });
  if (!row || row.workspaceId !== workspaceId) return null;

  const output = asCopyTexts(row.output);
  const editDistance = output ? copyEditDistance(output, input.finalCopy) : null;
  await prisma.copyGeneration.update({
    where: { id: row.id },
    data: {
      automationId: input.automationId,
      finalCopy: input.finalCopy as unknown as Prisma.InputJsonValue,
      editDistance,
    },
  });
  return { editDistance };
}

/* --------------------------------- purge ---------------------------------- */

/** Rows older than 90 days leave the table (driven by the purge cron route). */
export async function purgeExpiredCopyGenerations(now = new Date()): Promise<number> {
  const result = await prisma.copyGeneration.deleteMany({
    where: { createdAt: { lt: new Date(now.getTime() - RETENTION_MS) } },
  });
  return result.count;
}

/* --------------------------------- health --------------------------------- */

export async function getCopywriterHealth(): Promise<{
  status: string;
  pending: number;
  claimed: number;
  done: number;
  failed: number;
  activePromptVersionByWorkspace: Record<string, number | null>;
  timestamp: string;
}> {
  const [pending, claimed, done, failed, prompts] = await Promise.all([
    prisma.copyGeneration.count({ where: { status: "PENDING" } }),
    prisma.copyGeneration.count({ where: { status: "CLAIMED" } }),
    prisma.copyGeneration.count({ where: { status: "DONE" } }),
    prisma.copyGeneration.count({ where: { status: "FAILED" } }),
    prisma.copywriterPrompt.groupBy({
      by: ["workspaceId"],
      where: { isActive: true },
      _max: { version: true },
    }),
  ]);
  return {
    status: "ok",
    pending,
    claimed,
    done,
    failed,
    activePromptVersionByWorkspace: Object.fromEntries(
      prompts.map((prompt) => [prompt.workspaceId, prompt._max.version ?? null])
    ),
    timestamp: new Date().toISOString(),
  };
}
