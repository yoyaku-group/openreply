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
 * Calendar owns planning. A Calendar campaign with the same reference that has
 * not bound to a publication yet would otherwise create a second DM CTA once
 * the identically tagged post goes live.
 */
export async function findUnboundCalendarConflict(
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
      source: "CALENDAR",
      pendingNextReel: false,
      postId: null,
      lifecycle: { not: "ARCHIVED" },
      ...catnoTagWhere(input.catnoTag),
      ...(input.excludeAutomationId
        ? { id: { not: input.excludeAutomationId } }
        : {}),
    },
    select: CONFLICT_SELECT,
  });
}
