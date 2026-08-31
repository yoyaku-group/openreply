import { prisma } from "@/lib/db/client";
import { probeInstagramLoginScopes } from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";

/**
 * Error raised when a COMMENT-trigger automation is being created or
 * activated on an Instagram account whose token does not carry
 * `instagram_business_manage_comments`. The route handler converts this
 * into a 409 response with code MISSING_COMMENT_SCOPE so the dashboard
 * can surface a re-auth prompt with a direct deep link.
 */
export class MissingCommentScopeError extends Error {
  readonly code = "MISSING_COMMENT_SCOPE" as const;
  readonly accountId: string;
  readonly accountUsername: string;
  readonly postId: string;
  readonly missing: RequiredInstagramScope[];
  readonly fixUrl: string;

  constructor(args: {
    accountId: string;
    accountUsername: string;
    postId: string;
    missing: RequiredInstagramScope[];
  }) {
    super(
      `Account @${args.accountUsername} is missing scopes ${args.missing.join(
        ", "
      )} required to read comments on post ${args.postId}.`
    );
    this.name = "MissingCommentScopeError";
    this.accountId = args.accountId;
    this.accountUsername = args.accountUsername;
    this.postId = args.postId;
    this.missing = args.missing;
    this.fixUrl = "/settings/instagram/reconnect";
  }
}

/**
 * Thrown when a caller asks to probe or list an account that does not
 * belong to their workspace. Surfaced as 403 by the admin route handler —
 * never silently downgraded to "not found" (which would mask the boundary).
 */
export class CrossTenantAccessError extends Error {
  readonly code = "CROSS_TENANT_ACCESS" as const;
  constructor(
    public readonly accountId: string,
    public readonly workspaceId: string
  ) {
    super(`Account ${accountId} is not accessible from workspace ${workspaceId}.`);
    this.name = "CrossTenantAccessError";
  }
}

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
 * Read-only snapshot of an account's scope state from the local DB. NO
 * network call to Meta — this is what /api/health and any unauthenticated
 * route surface, so unauthenticated traffic cannot burn Meta rate limits
 * by spamming probes. To trigger a live Meta call, use `probeAccountScopes`
 * behind an authenticated admin endpoint.
 *
 * SECURITY: `workspaceId` is OPTIONAL only because /api/health is
 * unauthenticated and needs the operational roll-up across workspaces
 * for the load-balancer probe. Per-account detail lives at
 * /api/admin/instagram-scopes (auth-gated, workspace-scoped). All
 * authenticated callers MUST pass `workspaceId`.
 */
export interface CachedAccountScopes {
  accountId: string;
  username: string;
  granted: string[];
  missing: RequiredInstagramScope[];
  lastProbeAt: Date | null;
  archivedAt: Date | null;
}

export async function listCachedAccountScopes(
  workspaceId?: string
): Promise<CachedAccountScopes[]> {
  const where = workspaceId
    ? { workspaceId, archivedAt: null }
    : { archivedAt: null };
  const rows = await prisma.instagramAccount.findMany({
    where,
    select: {
      id: true,
      username: true,
      scopes: true,
      lastScopeProbeAt: true,
      archivedAt: true,
    },
    orderBy: { connectedAt: "asc" },
  });
  return rows.map((r) => ({
    accountId: r.id,
    username: r.username,
    granted: r.scopes,
    missing: computeMissing(r.scopes),
    lastProbeAt: r.lastScopeProbeAt,
    archivedAt: r.archivedAt,
  }));
}

/**
 * Probe a single Instagram account's current OAuth scopes via the functional
 * probe (`probeInstagramLoginScopes` — debug_token cannot parse Instagram
 * Login tokens), write the result back to the DB (so subsequent health
 * sweeps don't re-call Graph API unless the cache TTL has expired), and
 * return what is missing from the required list.
 *
 * SECURITY: this function hits Meta. It MUST only be called from
 * authenticated admin endpoints, never from public health/read endpoints —
 * otherwise unauthenticated traffic can burn through Meta rate limits by
 * spamming probes. Public callers should use `listCachedAccountScopes`.
 *
 * SECURITY: `workspaceId` is REQUIRED. Throws CrossTenantAccessError if
 * the account does not belong to that workspace — caller is responsible
 * for proving it can access this row.
 *
 * Concurrency: a per-process in-flight lock prevents the cache-defeat
 * pattern where N concurrent expired-cache calls each fire a Graph
 * request. While a probe is running, concurrent callers receive the
 * last-known cached value (possibly stale) instead of joining the stampede.
 *
 * The probe is best-effort: a rate-limit or transient error is surfaced
 * to the caller via `error` and `ok=false`, but never throws — health
 * routes need to keep responding even when the upstream is flaky.
 */
const PROBE_INFLIGHT = new Map<string, Promise<AccountScopeProbe>>();

export async function probeAccountScopes(
  accountId: string,
  opts: { workspaceId: string; forceRefresh?: boolean; cacheMs?: number }
): Promise<AccountScopeProbe> {
  const cacheMs = opts.cacheMs ?? 60 * 60 * 1000; // 1h default
  const account = await prisma.instagramAccount.findUnique({
    where: { id: accountId },
    select: {
      id: true,
      username: true,
      workspaceId: true,
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

  if (account.workspaceId !== opts.workspaceId) {
    // Refuse rather than silently return empty — caller must validate
    // workspace ownership before probing another tenant's token.
    throw new CrossTenantAccessError(accountId, opts.workspaceId);
  }

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

  // Cache-expired path: serialize via in-process lock so a load-balancer
  // health-check stampede only triggers one Meta call per account per TTL.
  const existing = PROBE_INFLIGHT.get(accountId);
  if (existing) return existing;

  const probe = runProbe(accountId, account.accessToken, account.scopes, account.lastScopeProbeAt);
  PROBE_INFLIGHT.set(accountId, probe);
  try {
    return await probe;
  } finally {
    PROBE_INFLIGHT.delete(accountId);
  }
}

async function runProbe(
  accountId: string,
  encryptedToken: string,
  fallbackGranted: string[],
  fallbackLastProbeAt: Date | null
): Promise<AccountScopeProbe> {
  try {
    const accessToken = decryptToken(encryptedToken);
    const granted = await probeInstagramLoginScopes(accessToken);
    const probedAt = new Date();

    await prisma.instagramAccount.update({
      where: { id: accountId },
      data: { scopes: granted, lastScopeProbeAt: probedAt },
    });

    return {
      accountId,
      username: "<unknown>",
      ok: true,
      grantedScopes: granted,
      missing: computeMissing(granted),
      lastProbeAt: probedAt,
    };
  } catch (error) {
    // Fail-open: surface the error, keep the cached scopes. The next sweep
    // can decide whether to retry.
    const message = error instanceof Error ? error.message : String(error);
    return {
      accountId,
      username: "<unknown>",
      ok: false,
      grantedScopes: fallbackGranted,
      missing: computeMissing(fallbackGranted),
      lastProbeAt: fallbackLastProbeAt,
      error: message,
    };
  }
}

export function computeMissing(granted: readonly string[]): RequiredInstagramScope[] {
  return REQUIRED_INSTAGRAM_SCOPES.filter((s) => !granted.includes(s));
}

/**
 * Pre-flight check for COMMENT-trigger automations. Validates that the
 * connected Instagram account holds the scopes needed to read comments on
 * the supplied post. Uses the cached scopes field (1h TTL from
 * `probeAccountScopes`) so the automation-create hot path is cheap — but
 * if the cache is expired this triggers a live Meta probe, so callers
 * should be authenticated operators (the route handler enforces it).
 *
 * SECURITY: `workspaceId` is REQUIRED and passed through to the probe.
 * The automations route already loads the InstagramAccount row with the
 * workspace filter, so this is always available there.
 *
 * Throws CrossTenantAccessError on workspace mismatch, or
 * MissingCommentScopeError when any required scope is missing.
 *
 * Kill-switch: when `OPENREPLY_COMMENTS_SCOPE_ADVISORY=true` (default false),
 * the activation flow is allowed to proceed even if `manage_comments` is
 * missing from the cached scopes — letting operators create + activate
 * campaigns while waiting for Meta App Review approval. Use only as a
 * transitional state; DM delivery still REQUIRES the scope in the token
 * (Meta never delivers webhook events without it). The bypass unblocks the
 * UX; it does NOT unlock delivery. Remove the flag once Meta approves the
 * scope AND each connected IG pro has been disconnected + reconnected (so
 * the probe captures the new scope).
 */
export async function assertCommentScope(args: {
  accountId: string;
  workspaceId: string;
  postId: string;
}): Promise<void> {
  const probe = await probeAccountScopes(args.accountId, {
    workspaceId: args.workspaceId,
    forceRefresh: false,
  });
  // Kill-switch — see docstring. Default off (the strict behaviour).
  if (
    probe.missing.length > 0 &&
    String(process.env.OPENREPLY_COMMENTS_SCOPE_ADVISORY || "").toLowerCase() ===
      "true"
  ) {
    // eslint-disable-next-line no-console
    console.warn(
      `[assertCommentScope][advisory-activation] accountId=${args.accountId} postId=${args.postId} missing=${probe.missing.join(",")} — OPENREPLY_COMMENTS_SCOPE_ADVISORY=true, allowing activation. DM delivery will NOT work until the scope is granted + the account is reconnected.`
    );
    return;
  }
  // Patch in the username from the cached snapshot — runProbe doesn't load
  // it (keeps the live-probe path lean).
  const username =
    probe.username === "<unknown>"
      ? (await prisma.instagramAccount.findUnique({
          where: { id: args.accountId },
          select: { username: true },
        }))?.username ?? "<unknown>"
      : probe.username;
  if (probe.missing.length > 0) {
    throw new MissingCommentScopeError({
      accountId: args.accountId,
      accountUsername: username,
      postId: args.postId,
      missing: probe.missing,
    });
  }
}

/**
 * Probe every non-archived Instagram account in a workspace in parallel.
 * Used by the admin route to surface drift in a single call. Failures on
 * individual accounts are isolated — one rate-limited probe does not
 * poison the rest.
 *
 * SECURITY: `workspaceId` is REQUIRED.
 */
export async function probeAllAccountScopes(
  workspaceId: string
): Promise<{
  accounts: AccountScopeProbe[];
  okCount: number;
  degradedCount: number;
}> {
  const live = await prisma.instagramAccount.findMany({
    where: { workspaceId, archivedAt: null },
    select: { id: true },
  });
  const probes = await Promise.all(
    live.map((a) => probeAccountScopes(a.id, { workspaceId }))
  );
  const okCount = probes.filter((p) => p.ok && p.missing.length === 0).length;
  const degradedCount = probes.length - okCount;
  return { accounts: probes, okCount, degradedCount };
}
