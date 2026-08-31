import {
  InstagramCapabilityKind,
  InstagramCapabilityStatus,
  Prisma,
} from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import {
  getInstagramWebhookSubscriptions,
  INSTAGRAM_CAPABILITY_KINDS,
  probeInstagramCapabilities,
  type InstagramCapabilityProbe,
} from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";

const PROBE_CACHE_MS = 60 * 60 * 1000;
export const CAPABILITY_STALE_MS = 24 * 60 * 60 * 1000;

const LEGACY_SCOPE_BY_KIND: Partial<Record<InstagramCapabilityKind, string>> = {
  BASIC: "instagram_business_basic",
  COMMENTS: "instagram_business_manage_comments",
  MESSAGES: "instagram_business_manage_messages",
  INSIGHTS: "instagram_business_manage_insights",
};

export interface CachedCapability {
  kind: InstagramCapabilityKind;
  status: InstagramCapabilityStatus;
  reason: string | null;
  evidence: unknown;
  checkedAt: Date | null;
  lastSuccessAt: Date | null;
}

export interface FeatureReadiness {
  ready: boolean;
  blockers: string[];
}

export interface InstagramCapabilitySnapshot {
  accountId: string;
  username: string;
  archivedAt: Date | null;
  subscribedFields: string[];
  subscriptionCheckedAt: Date | null;
  lastCommentWebhookAt: Date | null;
  lastMessageWebhookAt: Date | null;
  capabilities: Record<InstagramCapabilityKind, CachedCapability>;
  features: {
    comments: FeatureReadiness;
    messages: FeatureReadiness;
    insights: FeatureReadiness;
  };
  activeCommentAutomations: number;
  probeError?: string;
}

export class InstagramCapabilityBlockedError extends Error {
  readonly code = "INSTAGRAM_CAPABILITY_BLOCKED" as const;
  readonly fixUrl = "/settings";

  constructor(
    public readonly accountId: string,
    public readonly accountUsername: string,
    public readonly feature: "COMMENTS" | "MESSAGES" | "INSIGHTS",
    public readonly blockers: string[],
  ) {
    super(
      `@${accountUsername} cannot activate ${feature.toLowerCase()} automation: ${blockers.join(
        "; ",
      )}.`,
    );
    this.name = "InstagramCapabilityBlockedError";
  }
}

function unknownCapability(kind: InstagramCapabilityKind): CachedCapability {
  return {
    kind,
    status: "UNKNOWN",
    reason: "NOT_PROBED",
    evidence: null,
    checkedAt: null,
    lastSuccessAt: null,
  };
}

export function buildCapabilityRegistry(
  rows: CachedCapability[],
): Record<InstagramCapabilityKind, CachedCapability> {
  const result = Object.fromEntries(
    INSTAGRAM_CAPABILITY_KINDS.map((kind) => [kind, unknownCapability(kind)]),
  ) as Record<InstagramCapabilityKind, CachedCapability>;
  for (const row of rows) result[row.kind] = row;
  return result;
}

function isFresh(date: Date | null, maxAgeMs = CAPABILITY_STALE_MS): boolean {
  return Boolean(date && Date.now() - date.getTime() <= maxAgeMs);
}

export function evaluateInstagramFeature(
  feature: "COMMENTS" | "MESSAGES" | "INSIGHTS",
  capabilities: Record<InstagramCapabilityKind, CachedCapability>,
  subscribedFields: readonly string[],
  subscriptionCheckedAt: Date | null,
): FeatureReadiness {
  const blockers: string[] = [];
  const basic = capabilities.BASIC;
  const capability = capabilities[feature];

  if (basic.status !== "READY") {
    blockers.push(`basic=${basic.status}:${basic.reason ?? "NO_REASON"}`);
  } else if (!isFresh(basic.checkedAt)) {
    blockers.push("basic=STALE");
  }

  if (capability.status !== "READY") {
    blockers.push(
      `${feature.toLowerCase()}=${capability.status}:${capability.reason ?? "NO_REASON"}`,
    );
  } else if (!isFresh(capability.checkedAt)) {
    blockers.push(`${feature.toLowerCase()}=STALE`);
  }

  const subscribedField =
    feature === "COMMENTS"
      ? "comments"
      : feature === "MESSAGES"
        ? "messages"
        : null;
  if (subscribedField) {
    if (!isFresh(subscriptionCheckedAt)) {
      blockers.push("webhook_subscription=STALE_OR_UNVERIFIED");
    } else if (!subscribedFields.includes(subscribedField)) {
      blockers.push(`webhook_subscription=MISSING_${subscribedField}`);
    }
  }

  return { ready: blockers.length === 0, blockers };
}

type AccountWithCapabilities = {
  id: string;
  username: string;
  archivedAt: Date | null;
  subscribedFields: string[];
  subscriptionCheckedAt: Date | null;
  lastCommentWebhookAt: Date | null;
  lastMessageWebhookAt: Date | null;
  capabilities: CachedCapability[];
  _count: { automations: number };
};

function toSnapshot(
  account: AccountWithCapabilities,
): InstagramCapabilitySnapshot {
  const capabilities = buildCapabilityRegistry(account.capabilities);
  return {
    accountId: account.id,
    username: account.username,
    archivedAt: account.archivedAt,
    subscribedFields: [...account.subscribedFields].sort(),
    subscriptionCheckedAt: account.subscriptionCheckedAt,
    lastCommentWebhookAt: account.lastCommentWebhookAt,
    lastMessageWebhookAt: account.lastMessageWebhookAt,
    capabilities,
    features: {
      comments: evaluateInstagramFeature(
        "COMMENTS",
        capabilities,
        account.subscribedFields,
        account.subscriptionCheckedAt,
      ),
      messages: evaluateInstagramFeature(
        "MESSAGES",
        capabilities,
        account.subscribedFields,
        account.subscriptionCheckedAt,
      ),
      insights: evaluateInstagramFeature(
        "INSIGHTS",
        capabilities,
        account.subscribedFields,
        account.subscriptionCheckedAt,
      ),
    },
    activeCommentAutomations: account._count.automations,
  };
}

const ACCOUNT_CAPABILITY_SELECT = {
  id: true,
  username: true,
  archivedAt: true,
  subscribedFields: true,
  subscriptionCheckedAt: true,
  lastCommentWebhookAt: true,
  lastMessageWebhookAt: true,
  capabilities: {
    select: {
      kind: true,
      status: true,
      reason: true,
      evidence: true,
      checkedAt: true,
      lastSuccessAt: true,
    },
  },
  _count: {
    select: {
      automations: { where: { triggerType: "COMMENT", isActive: true } },
    },
  },
} satisfies Prisma.InstagramAccountSelect;

export async function listCachedInstagramCapabilities(
  workspaceId?: string,
): Promise<InstagramCapabilitySnapshot[]> {
  const accounts = await prisma.instagramAccount.findMany({
    where: workspaceId
      ? { workspaceId, archivedAt: null }
      : { archivedAt: null },
    orderBy: { connectedAt: "asc" },
    select: ACCOUNT_CAPABILITY_SELECT,
  });
  return accounts.map((account) => toSnapshot(account));
}

export function legacyScopesFromCapabilityProbe(
  probe: InstagramCapabilityProbe,
): string[] {
  return INSTAGRAM_CAPABILITY_KINDS.flatMap((kind) => {
    const scope = LEGACY_SCOPE_BY_KIND[kind];
    return scope && probe[kind].status === "READY" ? [scope] : [];
  });
}

export async function persistInstagramCapabilityProbe(args: {
  accountId: string;
  probe: InstagramCapabilityProbe;
  subscribedFields?: string[];
  checkedAt?: Date;
}): Promise<void> {
  const checkedAt = args.checkedAt ?? new Date();
  const subscribedFields = args.subscribedFields
    ? [...new Set(args.subscribedFields)].sort()
    : undefined;

  await prisma.$transaction(async (tx) => {
    await tx.instagramAccount.update({
      where: { id: args.accountId },
      data: {
        scopes: legacyScopesFromCapabilityProbe(args.probe),
        lastScopeProbeAt: checkedAt,
        ...(subscribedFields
          ? {
              subscribedFields,
              subscriptionCheckedAt: checkedAt,
              webhookSubscribed:
                subscribedFields.includes("comments") &&
                subscribedFields.includes("messages"),
            }
          : {}),
      },
    });

    for (const kind of INSTAGRAM_CAPABILITY_KINDS) {
      const result = args.probe[kind];
      await tx.instagramCapability.upsert({
        where: {
          instagramAccountId_kind: {
            instagramAccountId: args.accountId,
            kind,
          },
        },
        create: {
          instagramAccountId: args.accountId,
          kind,
          status: result.status,
          reason: result.reason,
          evidence: result.evidence as Prisma.InputJsonValue,
          checkedAt,
          lastSuccessAt: result.status === "READY" ? checkedAt : null,
        },
        update: {
          status: result.status,
          reason: result.reason,
          evidence: result.evidence as Prisma.InputJsonValue,
          checkedAt,
          ...(result.status === "READY" ? { lastSuccessAt: checkedAt } : {}),
        },
      });
    }
  });
}

const PROBE_INFLIGHT = new Map<string, Promise<InstagramCapabilitySnapshot>>();

export async function probeInstagramAccountCapabilities(
  accountId: string,
  opts: { workspaceId: string; forceRefresh?: boolean; cacheMs?: number },
): Promise<InstagramCapabilitySnapshot> {
  const account = await prisma.instagramAccount.findUnique({
    where: { id: accountId },
    select: {
      ...ACCOUNT_CAPABILITY_SELECT,
      workspaceId: true,
      instagramId: true,
      accessToken: true,
    },
  });
  if (!account || account.archivedAt) {
    throw new Error("InstagramAccount not found");
  }
  if (account.workspaceId !== opts.workspaceId) {
    throw new Error("CROSS_TENANT_ACCESS");
  }

  const snapshot = toSnapshot(account);
  const cacheMs = opts.cacheMs ?? PROBE_CACHE_MS;
  const coreCapabilities = [
    "BASIC",
    "COMMENTS",
    "MESSAGES",
    "INSIGHTS",
  ] as const;
  const fresh =
    !opts.forceRefresh &&
    isFresh(snapshot.subscriptionCheckedAt, cacheMs) &&
    coreCapabilities.every((kind) => {
      const capability = snapshot.capabilities[kind];
      return (
        isFresh(capability.checkedAt, cacheMs) &&
        capability.reason !== "NOT_PROBED"
      );
    });
  if (fresh) return snapshot;

  const running = PROBE_INFLIGHT.get(accountId);
  if (running) return running;

  const task = (async () => {
    try {
      const accessToken = decryptToken(account.accessToken);
      const [probe, subscribedFields] = await Promise.all([
        probeInstagramCapabilities(accessToken),
        getInstagramWebhookSubscriptions(account.instagramId, accessToken),
      ]);
      await persistInstagramCapabilityProbe({
        accountId,
        probe,
        subscribedFields,
      });
      const refreshed = await listCachedInstagramCapabilities(opts.workspaceId);
      return refreshed.find((row) => row.accountId === accountId) ?? snapshot;
    } catch (error) {
      return {
        ...snapshot,
        probeError: error instanceof Error ? error.message : String(error),
      };
    }
  })();

  PROBE_INFLIGHT.set(accountId, task);
  try {
    return await task;
  } finally {
    PROBE_INFLIGHT.delete(accountId);
  }
}

export async function probeAllInstagramCapabilities(
  workspaceId: string,
): Promise<{
  accounts: InstagramCapabilitySnapshot[];
  commentReadyCount: number;
  messageReadyCount: number;
  activeCommentBlockedCount: number;
}> {
  const accounts = await prisma.instagramAccount.findMany({
    where: { workspaceId, archivedAt: null },
    select: { id: true },
  });
  const snapshots = await Promise.all(
    accounts.map((account) =>
      probeInstagramAccountCapabilities(account.id, {
        workspaceId,
        forceRefresh: true,
      }),
    ),
  );
  return summarizeInstagramCapabilities(snapshots);
}

export function summarizeInstagramCapabilities(
  accounts: InstagramCapabilitySnapshot[],
) {
  return {
    accounts,
    commentReadyCount: accounts.filter((row) => row.features.comments.ready)
      .length,
    messageReadyCount: accounts.filter((row) => row.features.messages.ready)
      .length,
    activeCommentBlockedCount: accounts.filter(
      (row) => row.activeCommentAutomations > 0 && !row.features.comments.ready,
    ).length,
  };
}

export async function assertInstagramCommentCapability(args: {
  accountId: string;
  workspaceId: string;
}): Promise<void> {
  const snapshot = await probeInstagramAccountCapabilities(args.accountId, {
    workspaceId: args.workspaceId,
  });
  if (!snapshot.features.comments.ready) {
    throw new InstagramCapabilityBlockedError(
      snapshot.accountId,
      snapshot.username,
      "COMMENTS",
      snapshot.features.comments.blockers,
    );
  }
}

export async function assertInstagramMessageCapability(args: {
  accountId: string;
  workspaceId: string;
}): Promise<void> {
  const snapshot = await probeInstagramAccountCapabilities(args.accountId, {
    workspaceId: args.workspaceId,
  });
  if (!snapshot.features.messages.ready) {
    throw new InstagramCapabilityBlockedError(
      snapshot.accountId,
      snapshot.username,
      "MESSAGES",
      snapshot.features.messages.blockers,
    );
  }
}

export async function recordInstagramWebhookCapability(
  accountId: string,
  kind: "COMMENTS" | "MESSAGES",
): Promise<void> {
  const now = new Date();
  const field = kind === "COMMENTS" ? "comments" : "messages";
  const account = await prisma.instagramAccount.findUnique({
    where: { id: accountId },
    select: { subscribedFields: true },
  });
  if (!account) return;

  const subscribedFields = [...new Set([...account.subscribedFields, field])];

  await prisma.$transaction([
    prisma.instagramAccount.update({
      where: { id: accountId },
      data: {
        subscribedFields,
        subscriptionCheckedAt: now,
        webhookSubscribed:
          subscribedFields.includes("comments") &&
          subscribedFields.includes("messages"),
        ...(kind === "COMMENTS"
          ? { lastCommentWebhookAt: now }
          : { lastMessageWebhookAt: now }),
      },
    }),
    prisma.instagramCapability.upsert({
      where: {
        instagramAccountId_kind: { instagramAccountId: accountId, kind },
      },
      create: {
        instagramAccountId: accountId,
        kind,
        status: "READY",
        reason: "WEBHOOK_RECEIVED",
        evidence: { field },
        checkedAt: now,
        lastSuccessAt: now,
      },
      update: {
        status: "READY",
        reason: "WEBHOOK_RECEIVED",
        evidence: { field },
        checkedAt: now,
        lastSuccessAt: now,
      },
    }),
  ]);
}
