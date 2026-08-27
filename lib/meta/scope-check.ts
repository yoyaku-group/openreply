import { prisma } from "@/lib/db/client";
import { debugToken } from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";

/**
 * OAuth scopes an OpenReply Instagram account must hold for the platform to
 * deliver on its comment-to-DM contract. `instagram_business_manage_comments`
 * is the silent-killer scope: without it, the Graph API returns `data: []` on
 * `/{media_id}/comments` despite `comments_count > 0`, and webhook events for
 * comments never arrive. Tokens issued before this list existed carry only the
 * first two scopes — that's the drift the IG-account re-authorization flow
 * exists to repair.
 */
export const REQUIRED_INSTAGRAM_SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_messages",
  "instagram_business_manage_comments",
] as const;

export type RequiredInstagramScope = (typeof REQUIRED_INSTAGRAM_SCOPES)[number];

export interface AccountScopeProbe {
  accountId: string;
  username: string;
  ok: boolean;
  grantedScopes: string[];
  missing: RequiredInstagramScope[];
  lastProbeAt: Date | null;
  error?: string;
}

/**
 * Probe a single Instagram account's current OAuth scopes via
 * `/debug_token`, write the result back to the DB (so subsequent health
 * sweeps don't re-call Graph API unless the cache TTL has expired), and
 * return what is missing from the required list.
 *
 * The probe is best-effort: a rate-limit or transient error is surfaced
 * to the caller via `error` and `ok=false`, but never throws — health
 * routes need to keep responding even when the upstream is flaky.
 */
export async function probeAccountScopes(
  accountId: string,
  opts: { forceRefresh?: boolean; cacheMs?: number } = {}
): Promise<AccountScopeProbe> {
  const cacheMs = opts.cacheMs ?? 60 * 60 * 1000; // 1h default
  const account = await prisma.instagramAccount.findUnique({
    where: { id: accountId },
    select: {
      id: true,
      username: true,
      accessToken: true,
      scopes: true,
      lastScopeProbeAt: true,
      archivedAt: true,
    },
  });

  if (!account) {
    return {
      accountId,
      username: "<unknown>",
      ok: false,
      grantedScopes: [],
      missing: [...REQUIRED_INSTAGRAM_SCOPES],
      lastProbeAt: null,
      error: "InstagramAccount not found",
    };
  }

  if (account.archivedAt) {
    // Archived accounts are intentionally out of the live scope-check
    // pipeline; they belong to the Phase-4 audit, not the runtime guard.
    return {
      accountId,
      username: account.username,
      ok: true,
      grantedScopes: account.scopes,
      missing: [],
      lastProbeAt: account.lastScopeProbeAt,
    };
  }

  const fresh =
    !opts.forceRefresh &&
    account.lastScopeProbeAt &&
    Date.now() - account.lastScopeProbeAt.getTime() < cacheMs;

  if (fresh && account.scopes.length > 0) {
    return {
      accountId,
      username: account.username,
      ok: true,
      grantedScopes: account.scopes,
      missing: computeMissing(account.scopes),
      lastProbeAt: account.lastScopeProbeAt,
    };
  }

  try {
    const accessToken = decryptToken(account.accessToken);
    const probed = (await debugToken(accessToken, accessToken)) as {
      data?: { scopes?: string[] };
    };
    const granted = Array.isArray(probed?.data?.scopes)
      ? probed!.data!.scopes!
      : [];
    const probedAt = new Date();

    await prisma.instagramAccount.update({
      where: { id: accountId },
      data: { scopes: granted, lastScopeProbeAt: probedAt },
    });

    return {
      accountId,
      username: account.username,
      ok: true,
      grantedScopes: granted,
      missing: computeMissing(granted),
      lastProbeAt: probedAt,
    };
  } catch (error) {
    // Fail-open: log, mark lastProbeAt so the next sweep can decide whether
    // to retry, and surface the error to the caller. The DB row keeps its
    // previous (possibly empty) scopes so /api/health reflects reality.
    const message = error instanceof Error ? error.message : String(error);
    return {
      accountId,
      username: account.username,
      ok: false,
      grantedScopes: account.scopes,
      missing: computeMissing(account.scopes),
      lastProbeAt: account.lastScopeProbeAt,
      error: message,
    };
  }
}

export function computeMissing(granted: readonly string[]): RequiredInstagramScope[] {
  return REQUIRED_INSTAGRAM_SCOPES.filter((s) => !granted.includes(s));
}

/**
 * Probe every non-archived Instagram account in parallel. Used by
 * `/api/health` to surface drift in a single call. Failures on individual
 * accounts are isolated — one rate-limited probe does not poison the rest.
 */
export async function probeAllAccountScopes(): Promise<{
  accounts: AccountScopeProbe[];
  okCount: number;
  degradedCount: number;
}> {
  const live = await prisma.instagramAccount.findMany({
    where: { archivedAt: null },
    select: { id: true },
  });
  const probes = await Promise.all(live.map((a) => probeAccountScopes(a.id)));
  const okCount = probes.filter((p) => p.ok && p.missing.length === 0).length;
  const degradedCount = probes.length - okCount;
  return { accounts: probes, okCount, degradedCount };
}
