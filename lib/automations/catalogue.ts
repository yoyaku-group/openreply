import type { Prisma } from "@/app/generated/prisma/client";

/**
 * Catalogue-reference helpers shared by the campaign API, the schema and the
 * attach binder. A catalogue tag is the hashtag printed on a release
 * (`#ABC001`), not the comment keyword that triggers the DM.
 */

export const CATNO_TAG_MAX_LENGTH = 50;
const CATNO_TOKEN = /^[A-Za-z0-9_]+$/;

export type CatnoParseResult =
  | { ok: true; value: string }
  | { ok: false; message: string };

export function parseCatnoTag(value: string): CatnoParseResult {
  const trimmed = value.trim();
  const token = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  if (!token) {
    return { ok: false, message: "Enter a catalogue hashtag, for example #ABC001" };
  }
  if (token.length > CATNO_TAG_MAX_LENGTH) {
    return {
      ok: false,
      message: `Catalogue hashtags are at most ${CATNO_TAG_MAX_LENGTH} characters`,
    };
  }
  if (!CATNO_TOKEN.test(token)) {
    return {
      ok: false,
      message:
        "Catalogue hashtags may only contain ASCII letters, digits and underscores (one optional leading #)",
    };
  }
  return { ok: true, value: token.toUpperCase() };
}

/** Canonical stored form: no leading #, trimmed, upper-case. */
export function normalizeCatnoTag(
  value: string | null | undefined,
): string | null {
  if (value == null) return null;
  const parsed = parseCatnoTag(value);
  return parsed.ok ? parsed.value : null;
}

/** Display form used by the UI and status vocabulary. */
export function displayCatnoTag(value: string | null | undefined): string | null {
  const normalized = normalizeCatnoTag(value);
  return normalized ? `#${normalized}` : null;
}

/**
 * Compare references for immutability checks. Canonical forms compare
 * case-insensitively; legacy values that the new strict input would reject
 * (for example punctuation already stored on a bound campaign) still compare
 * exactly so ordinary edits can preserve them without resubmitting them.
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

type AutomationClient = Pick<Prisma.TransactionClient, "automation">;

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

const CONFLICT_SELECT = {
  id: true,
  name: true,
  source: true,
  lifecycle: true,
  isActive: true,
} satisfies Prisma.AutomationSelect;

/**
 * Match the canonical stored form and the legacy `#ABC001` form, regardless of
 * case. Calendar rows are written by a different source that has historically
 * kept the leading `#`; equality on the bare token alone would miss them.
 */
function catnoTagWhere(catnoTag: string): Prisma.AutomationWhereInput {
  const token = normalizeCatnoTag(catnoTag) ?? catnoTag;
  return {
    OR: [
      { catnoTag: { equals: token, mode: "insensitive" } },
      { catnoTag: { equals: `#${token}`, mode: "insensitive" } },
    ],
  };
}

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
  client: AutomationClient,
): Promise<PendingCatalogueConflict | null> {
  return client.automation.findFirst({
    where: {
      instagramAccountId: input.instagramAccountId,
      pendingNextReel: true,
      lifecycle: { not: "ARCHIVED" },
      ...catnoTagWhere(input.catnoTag),
      ...(input.excludeAutomationId
        ? { id: { not: input.excludeAutomationId } }
        : {}),
    },
    select: CONFLICT_SELECT,
  });
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
  client: AutomationClient,
): Promise<PendingCatalogueConflict | null> {
  return client.automation.findFirst({
    where: {
      instagramAccountId: input.instagramAccountId,
      postId: input.postId,
      isActive: true,
      lifecycle: { not: "ARCHIVED" },
      ...catnoTagWhere(input.catnoTag),
      ...(input.excludeAutomationId
        ? { id: { not: input.excludeAutomationId } }
        : {}),
    },
    select: CONFLICT_SELECT,
  });
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
  client: AutomationClient,
): Promise<PendingCatalogueConflict | null> {
  return client.automation.findFirst({
    where: {
      instagramAccountId: input.instagramAccountId,
      source: "CALENDAR",
      pendingNextReel: false,
      // A paused Calendar campaign cannot send, so it must not keep a sendable
      // manual campaign parked. Only an active Calendar row can duplicate a DM.
      lifecycle: { notIn: ["ARCHIVED", "PAUSED"] },
      AND: [
        catnoTagWhere(input.catnoTag),
        input.mediaId
          ? { OR: [{ postId: null }, { postId: input.mediaId }] }
          : { postId: null },
      ],
      ...(input.excludeAutomationId
        ? { id: { not: input.excludeAutomationId } }
        : {}),
    },
    select: CONFLICT_SELECT,
  });
}
