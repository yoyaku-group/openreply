import type { Prisma } from "@/app/generated/prisma/client";

/**
 * Catalogue-reference helpers shared by the campaign API, the schema and the
 * attach binder. A catalogue tag is the hashtag printed on a release
 * (`#ABC001`), not the comment keyword that triggers the DM.
 *
 * The canonical stored form keeps only `[A-Z0-9]`: `LM-02`, `lm02`, `#LM_02`
 * and `lm 02` all store as `LM02`. Separators are accepted on input because
 * real catalogue numbers carry them, but they must never reach a caption —
 * Instagram ends a hashtag at a dash, so the published hashtag is `#LM02`.
 */

export const CATNO_TAG_MAX_LENGTH = 50;

/** Input charset: letters, digits, separators and one optional leading #. */
const CATNO_INPUT = /^[A-Za-z0-9_ -]+$/;

/** A caption hashtag: # then at least one Instagram hashtag character. */
const CAPTION_CATNO_TOKEN = /#([A-Za-z0-9][A-Za-z0-9_-]*)/g;

export type CatnoParseResult =
  | { ok: true; value: string }
  | { ok: false; message: string };

/** Canonical stored form: no leading #, trimmed, upper-case, `[A-Z0-9]` only. */
export function normalizeCatnoTag(
  value: string | null | undefined,
): string | null {
  if (value == null) return null;
  // One optional leading # is input sugar, not part of the reference.
  const token = value.trim().replace(/^#/, "");
  const normalized = token.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return normalized || null;
}

export function parseCatnoTag(value: string): CatnoParseResult {
  const trimmed = value.trim();
  const token = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  if (!token) {
    return { ok: false, message: "Enter a catalogue hashtag, for example #ABC001" };
  }
  if (!CATNO_INPUT.test(token)) {
    return {
      ok: false,
      message:
        "Catalogue references may only contain letters, digits, dashes, underscores and spaces (one optional leading #)",
    };
  }
  const normalized = normalizeCatnoTag(token);
  if (!normalized) {
    return { ok: false, message: "Enter a catalogue hashtag, for example #ABC001" };
  }
  if (normalized.length < 3) {
    return {
      ok: false,
      message: "A catalogue reference needs at least 3 characters, for example #ABC001",
    };
  }
  if (normalized.length > CATNO_TAG_MAX_LENGTH) {
    return {
      ok: false,
      message: `Catalogue references are at most ${CATNO_TAG_MAX_LENGTH} characters`,
    };
  }
  if (!/\d/.test(normalized)) {
    return {
      ok: false,
      message: "A catalogue reference needs at least one digit, for example #ABC001",
    };
  }
  return { ok: true, value: normalized };
}

/**
 * Every catalogue reference a caption carries, in canonical form and in
 * order of first appearance. Tokens that fail `parseCatnoTag` (too short,
 * no digit, over-long) are not references and are dropped.
 */
export function extractCaptionCatnoTags(caption: string): string[] {
  const found: string[] = [];
  for (const match of caption.matchAll(CAPTION_CATNO_TOKEN)) {
    const parsed = parseCatnoTag(match[1]);
    if (parsed.ok && !found.includes(parsed.value)) {
      found.push(parsed.value);
    }
  }
  return found;
}

/**
 * Whole-token equality: true only when the caption carries the exact
 * reference. `#LM-02`, `#lm02`, `#LM_02` and `#LM02` all match the tag
 * `LM02`; `#LM02X` does not; a tag without a digit is never a reference
 * and never matches.
 */
export function captionHasCatnoTag(caption: string, tag: string): boolean {
  const normalized = normalizeCatnoTag(tag);
  if (!normalized) return false;
  return extractCaptionCatnoTags(caption).includes(normalized);
}

/** Display form used by the UI and status vocabulary. */
export function displayCatnoTag(value: string | null | undefined): string | null {
  const normalized = normalizeCatnoTag(value);
  return normalized ? `#${normalized}` : null;
}

/**
 * Compare references for immutability checks. Canonical forms compare on the
 * normalized value, so legacy rows that still hold a separator form
 * (`LM-02`) compare equal to their canonical form (`LM02`). Values that
 * normalize to nothing (for example pure punctuation) compare exactly so
 * ordinary edits can preserve them without resubmitting them.
 */
export function catnoTagsEqual(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (left == null || right == null) return left == null && right == null;
  const normalizedLeft = normalizeCatnoTag(left);
  const normalizedRight = normalizeCatnoTag(right);
  if (normalizedLeft && normalizedRight) {
    return normalizedLeft === normalizedRight;
  }
  return left.trim() === right.trim();
}

/**
 * Serialize pending-campaign writes per Instagram account. Generic next-post
 * and catalogue campaigns share this lock so their conflict checks cannot
 * interleave with each other.
 */
export async function lockPendingAutomationAccount(
  tx: Prisma.TransactionClient,
  instagramAccountId: string,
) {
  // $executeRaw: the lock call returns void, which $queryRaw cannot deserialize
  // with the Prisma driver adapter.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(
    hashtext('openreply:pending-next'),
    hashtext(${instagramAccountId})
  )`;
}

export interface PendingCatalogueConflict {
  id: string;
  name: string;
  source: string;
  lifecycle: string;
  isActive: boolean;
}

type RawQueryClient = Pick<Prisma.TransactionClient, "$queryRaw">;

/**
 * One waiting campaign per normalized catalogue reference and account,
 * including inactive drafts. A campaign stops waiting as soon as the binder
 * sets `pendingNextReel` to false, so a replacement can then be armed.
 */
export async function findPendingCatalogueConflict(
  input: {
    instagramAccountId: string;
    catnoTag: string;
    excludeAutomationId?: string;
  },
  client: RawQueryClient,
): Promise<PendingCatalogueConflict | null> {
  const token = normalizeCatnoTag(input.catnoTag);
  if (!token) return null;
  const rows = await client.$queryRaw<PendingCatalogueConflict[]>`
    SELECT "id", "name", "source", "lifecycle", "isActive"
    FROM "Automation"
    WHERE "instagramAccountId" = ${input.instagramAccountId}
      AND upper(regexp_replace("catnoTag", '[^A-Za-z0-9]', '', 'g')) = ${token}
      AND "pendingNextReel" = true
      AND "lifecycle" <> 'ARCHIVED'
      AND "id" <> COALESCE(${input.excludeAutomationId ?? null}, '')
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * A manual campaign that already bound to its publication keeps answering a
 * comment with its own DM. DM idempotence is per automation, so activating a
 * Calendar campaign for the same reference on the same post would send a
 * second private message per comment. The unbound-Calendar checks above only
 * run while the manual campaign still waits; this one covers the bound case.
 */
export async function findActivePostCatalogueConflict(
  input: {
    instagramAccountId: string;
    catnoTag: string;
    postId: string;
    excludeAutomationId?: string;
  },
  client: RawQueryClient,
): Promise<PendingCatalogueConflict | null> {
  const token = normalizeCatnoTag(input.catnoTag);
  if (!token) return null;
  const rows = await client.$queryRaw<PendingCatalogueConflict[]>`
    SELECT "id", "name", "source", "lifecycle", "isActive"
    FROM "Automation"
    WHERE "instagramAccountId" = ${input.instagramAccountId}
      AND upper(regexp_replace("catnoTag", '[^A-Za-z0-9]', '', 'g')) = ${token}
      AND "postId" = ${input.postId}
      AND "isActive" = true
      AND "lifecycle" <> 'ARCHIVED'
      AND "id" <> COALESCE(${input.excludeAutomationId ?? null}, '')
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Calendar owns planning. A Calendar campaign with the same reference that has
 * not bound to a publication yet would otherwise create a second DM CTA once
 * the identically tagged post goes live. When a candidate media is supplied,
 * also treat a Calendar campaign already bound to that exact media as a
 * conflict: the Calendar binder may have won the race after the manual
 * campaign was armed.
 */
export async function findUnboundCalendarConflict(
  input: {
    instagramAccountId: string;
    catnoTag: string;
    mediaId?: string | null;
    excludeAutomationId?: string;
  },
  client: RawQueryClient,
): Promise<PendingCatalogueConflict | null> {
  const token = normalizeCatnoTag(input.catnoTag);
  if (!token) return null;
  // COALESCE collapses the two shapes of the publication predicate: with a
  // candidate media, an unbound Calendar row (postId IS NULL) or one bound to
  // that exact media both conflict; without one, only the unbound row does.
  const rows = await client.$queryRaw<PendingCatalogueConflict[]>`
    SELECT "id", "name", "source", "lifecycle", "isActive"
    FROM "Automation"
    WHERE "instagramAccountId" = ${input.instagramAccountId}
      AND upper(regexp_replace("catnoTag", '[^A-Za-z0-9]', '', 'g')) = ${token}
      AND "source" = 'CALENDAR'
      AND "pendingNextReel" = false
      AND "lifecycle" NOT IN ('ARCHIVED', 'PAUSED')
      AND ("postId" IS NULL OR "postId" = COALESCE(${input.mediaId ?? null}, ''))
      AND "id" <> COALESCE(${input.excludeAutomationId ?? null}, '')
    LIMIT 1
  `;
  return rows[0] ?? null;
}
