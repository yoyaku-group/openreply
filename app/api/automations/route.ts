import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@/app/generated/prisma/client";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { calculateCtr, normalizeTopKeywords } from "@/lib/tracking/analytics";
import { buildTrackedUrl } from "@/lib/tracking/message";
import { generateTrackedLinkSlug } from "@/lib/tracking/server";
import { buildReportUrl, generateReportShareSlug } from "@/lib/reports/share";
import { normalizeInboundDmKeywords } from "@/lib/automations/inbound-dm";
import { getMediaById } from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

// This list is read-your-writes (created/imported campaigns must show up
// immediately), so never cache it at the route or CDN layer.
export const dynamic = "force-dynamic";

const triggerTypeSchema = z.enum(["COMMENT", "INBOUND_DM"]);

const createAutomationSchema = z.object({
    name: z.string().min(1).max(100),
    goal: z.string().min(1).max(120).optional().nullable(),
    instagramAccountId: z.string().min(1).optional().nullable(),
    triggerType: triggerTypeSchema.optional().default("COMMENT"),
    postId: z.string().min(1).optional().nullable(),
    postUrl: z.string().url().optional().nullable(),
    pendingNextReel: z.boolean().optional().default(false),
    matchAnyPost: z.boolean().optional().default(false),
    keywords: z.array(z.string().min(1).max(50)).max(10).optional().default([]),
    matchAnyWord: z.boolean().optional().default(false),
    dmMessage: z.string().min(1).max(1000),
    openingDmEnabled: z.boolean().optional().default(false),
    openingDmMessage: z.string().max(1000).optional().nullable(),
    openingDmButtonLabel: z.string().max(20).optional().nullable(),
    linkButtonLabel: z.string().max(20).optional().nullable(),
    requireFollow: z.boolean().optional().default(false),
    followPromptMessage: z.string().max(1000).optional().nullable(),
    followPromptButtonLabel: z.string().max(20).optional().nullable(),
    followUpEnabled: z.boolean().optional().default(false),
    followUpMessage: z.string().max(1000).optional().nullable(),
    publicReplyEnabled: z.boolean().optional().default(false),
    publicReplyMessage: z.string().max(1000).optional().nullable(),
    publicReplyMessages: z
      .array(z.string().max(1000))
      .max(10)
      .optional()
      .default([]),
    // Empty string means "no tracked link"; a URL sets one.
    trackedDestinationUrl: z
      .union([z.string().url(), z.literal("")])
      .optional()
      .nullable(),
    // Optional second tracked link, rendered as a second DM button.
    secondaryDestinationUrl: z
      .union([z.string().url(), z.literal("")])
      .optional()
      .nullable(),
    secondaryButtonLabel: z.string().max(20).optional().nullable(),
    isActive: z.boolean().optional().default(true),
    wholeWordMatch: z.boolean().optional().default(true),
  });

const updateAutomationSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  goal: z.string().min(1).max(120).optional().nullable(),
  triggerType: triggerTypeSchema.optional(),
  postId: z.string().min(1).optional().nullable(),
  postUrl: z.string().url().optional().nullable(),
  pendingNextReel: z.boolean().optional(),
  matchAnyPost: z.boolean().optional(),
  keywords: z.array(z.string().min(1).max(50)).max(10).optional(),
  matchAnyWord: z.boolean().optional(),
  dmMessage: z.string().min(1).max(1000).optional(),
  openingDmEnabled: z.boolean().optional(),
  openingDmMessage: z.string().max(1000).optional().nullable(),
  openingDmButtonLabel: z.string().max(20).optional().nullable(),
  linkButtonLabel: z.string().max(20).optional().nullable(),
  requireFollow: z.boolean().optional(),
  followPromptMessage: z.string().max(1000).optional().nullable(),
  followPromptButtonLabel: z.string().max(20).optional().nullable(),
  followUpEnabled: z.boolean().optional(),
  followUpMessage: z.string().max(1000).optional().nullable(),
  publicReplyEnabled: z.boolean().optional(),
  publicReplyMessage: z.string().max(1000).optional().nullable(),
  publicReplyMessages: z.array(z.string().max(1000)).max(10).optional(),
  isActive: z.boolean().optional(),
  wholeWordMatch: z.boolean().optional(),
  reportShareEnabled: z.boolean().optional(),
  // Empty string clears the tracked link; a URL updates/creates it; undefined
  // leaves it unchanged.
  trackedDestinationUrl: z
    .union([z.string().url(), z.literal("")])
    .optional()
    .nullable(),
  // Same semantics for the optional second tracked link / DM button.
  secondaryDestinationUrl: z
    .union([z.string().url(), z.literal("")])
    .optional()
    .nullable(),
  secondaryButtonLabel: z.string().max(20).optional().nullable(),
});

type TriggerType = z.infer<typeof triggerTypeSchema>;

interface AutomationConfiguration {
  triggerType: TriggerType;
  postId?: string | null;
  pendingNextReel: boolean;
  matchAnyPost: boolean;
  keywords: string[];
  matchAnyWord: boolean;
  openingDmEnabled: boolean;
  openingDmMessage?: string | null;
  openingDmButtonLabel?: string | null;
}

interface ConfigurationIssue {
  path: string;
  message: string;
}

function validateAutomationConfiguration(
  configuration: AutomationConfiguration
): ConfigurationIssue[] {
  const issues: ConfigurationIssue[] = [];

  if (configuration.triggerType === "INBOUND_DM") {
    if (configuration.matchAnyWord) {
      issues.push({
        path: "matchAnyWord",
        message: "Inbound DM campaigns require exact keywords",
      });
    }

    const normalized = normalizeInboundDmKeywords(configuration.keywords);
    if (configuration.keywords.length === 0) {
      issues.push({
        path: "keywords",
        message: "Add at least one exact inbound DM keyword",
      });
    } else if (normalized.invalid.length > 0) {
      issues.push({
        path: "keywords",
        message:
          "Inbound DM keywords must each be one exact word or catalogue token",
      });
    } else if (normalized.duplicates.length > 0) {
      issues.push({
        path: "keywords",
        message: "Inbound DM keywords must be unique after normalization",
      });
    }
    return issues;
  }

  if (
    !configuration.matchAnyPost &&
    !configuration.pendingNextReel &&
    !configuration.postId
  ) {
    issues.push({
      path: "postId",
      message: "Choose which post(s) trigger the campaign",
    });
  }
  if (!configuration.matchAnyWord && configuration.keywords.length === 0) {
    issues.push({
      path: "keywords",
      message: "Add at least one keyword, or match any word",
    });
  }
  if (
    configuration.openingDmEnabled &&
    (!configuration.openingDmMessage?.trim() ||
      !configuration.openingDmButtonLabel?.trim())
  ) {
    issues.push({
      path: "openingDmMessage",
      message: "Opening DM needs a message and a button label",
    });
  }
  return issues;
}

function configurationError(issues: ConfigurationIssue[]) {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of issues) {
    fieldErrors[issue.path] = [...(fieldErrors[issue.path] ?? []), issue.message];
  }
  return NextResponse.json(
    {
      success: false,
      error: "Invalid input",
      details: { formErrors: [], fieldErrors },
    },
    { status: 400 }
  );
}

function inboundDmOnlyFields() {
  return {
    postId: null,
    postUrl: null,
    pendingNextReel: false,
    matchAnyPost: false,
    matchAnyWord: false,
    openingDmEnabled: false,
    openingDmMessage: null,
    openingDmButtonLabel: null,
    requireFollow: false,
    followPromptMessage: null,
    followPromptButtonLabel: null,
    followUpEnabled: false,
    followUpMessage: null,
    publicReplyEnabled: false,
    publicReplyMessage: null,
    publicReplyMessages: [] as string[],
  };
}

async function findInboundKeywordConflicts(input: {
  instagramAccountId: string;
  keywords: string[];
  excludeAutomationId?: string;
}, client: Pick<Prisma.TransactionClient, "automation"> = prisma) {
  const requested = new Set(normalizeInboundDmKeywords(input.keywords).normalized);
  if (requested.size === 0) return [];

  const activeCampaigns = await client.automation.findMany({
    where: {
      instagramAccountId: input.instagramAccountId,
      triggerType: "INBOUND_DM",
      isActive: true,
      ...(input.excludeAutomationId
        ? { id: { not: input.excludeAutomationId } }
        : {}),
    },
    select: { id: true, name: true, keywords: true },
  });

  return activeCampaigns.flatMap((campaign) => {
    const overlap = normalizeInboundDmKeywords(campaign.keywords).normalized.filter(
      (keyword) => requested.has(keyword)
    );
    return overlap.length > 0 ? [{ ...campaign, overlap }] : [];
  });
}

type InboundKeywordConflicts = Awaited<
  ReturnType<typeof findInboundKeywordConflicts>
>;

function inboundKeywordConflictResponse(conflicts: InboundKeywordConflicts) {
  return NextResponse.json(
    {
      success: false,
      code: "INBOUND_KEYWORD_CONFLICT",
      error: `An active inbound DM campaign already uses: ${conflicts
        .flatMap((conflict) => conflict.overlap)
        .join(", ")}`,
      conflicts,
    },
    { status: 409 }
  );
}

async function lockInboundKeywordAccount(
  tx: Prisma.TransactionClient,
  instagramAccountId: string
) {
  // Serialize active inbound-keyword writes per Instagram account. The
  // conflict check and the write happen under this transaction-scoped lock,
  // so two concurrent activations cannot both pass the check.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(
    hashtext('openreply:inbound-dm-keywords'),
    hashtext(${instagramAccountId})
  )`;
}

async function postAccessibilityError(
  account: { username: string; accessToken: string },
  postId: string
) {
  try {
    const accessToken = decryptToken(account.accessToken);
    await getMediaById(accessToken, postId);
    return null;
  } catch {
    return NextResponse.json(
      {
        success: false,
        code: "POST_NOT_ACCESSIBLE",
        error: `This post is not accessible from @${account.username}. Choose media published by this connected account or keep the campaign paused.`,
      },
      { status: 409 }
    );
  }
}

export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }
  const instagramAccountId =
    request.nextUrl.searchParams.get("instagramAccountId");
  const accountFilter =
    instagramAccountId && instagramAccountId !== "all"
      ? { instagramAccountId }
      : {};

  const automations = await prisma.automation.findMany({
    where: { workspaceId, ...accountFilter },
    include: {
      instagramAccount: {
        select: { username: true, instagramId: true },
      },
      _count: {
        select: { dmLogs: true },
      },
      trackedLinks: {
        select: {
          id: true,
          slug: true,
          label: true,
          destinationUrl: true,
          _count: { select: { clicks: true } },
        },
        orderBy: { createdAt: "asc" },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const automationsWithReports = await Promise.all(
    automations.map(async (automation) => {
      if (automation.reportShareSlug) return automation;

      const updated = await prisma.automation.update({
        where: { id: automation.id },
        data: { reportShareSlug: generateReportShareSlug() },
        select: { reportShareSlug: true },
      });

      return {
        ...automation,
        reportShareSlug: updated.reportShareSlug,
      };
    })
  );

  const [statusCounts, clickCounts, keywordCounts] = await Promise.all([
    prisma.dmLog.groupBy({
      by: ["automationId", "status"],
      where: { workspaceId },
      _count: { _all: true },
    }),
    prisma.linkClick.groupBy({
      by: ["automationId"],
      where: { workspaceId },
      _count: { _all: true },
    }),
    prisma.dmLog.groupBy({
      by: ["automationId", "matchedKeyword"],
      where: { workspaceId, matchedKeyword: { not: null } },
      _count: { _all: true },
    }),
  ]);

  const analytics = new Map<
    string,
    {
      sent: number;
      skipped: number;
      failed: number;
      clicks: number;
      topKeywords: { keyword: string; count: number }[];
    }
  >();

  for (const automation of automationsWithReports) {
    analytics.set(automation.id, {
      sent: 0,
      skipped: 0,
      failed: 0,
      clicks: 0,
      topKeywords: [],
    });
  }

  for (const row of statusCounts) {
    const item = analytics.get(row.automationId);
    if (!item) continue;
    const count = row._count._all;
    if (row.status === "SENT") item.sent += count;
    if (row.status === "FAILED") item.failed += count;
    if (row.status.startsWith("SKIPPED_")) item.skipped += count;
  }

  for (const row of clickCounts) {
    const item = analytics.get(row.automationId);
    if (item) item.clicks = row._count._all;
  }

  for (const automation of automationsWithReports) {
    const item = analytics.get(automation.id);
    if (!item) continue;
    item.topKeywords = normalizeTopKeywords(
      keywordCounts
        .filter((row) => row.automationId === automation.id)
        .map((row) => ({
          matchedKeyword: row.matchedKeyword,
          _count: row._count._all,
        })),
      3
    );
  }

  return NextResponse.json(
    {
    success: true,
    data: automationsWithReports.map((automation) => {
      const item = analytics.get(automation.id) ?? {
        sent: 0,
        skipped: 0,
        failed: 0,
        clicks: 0,
        topKeywords: [],
      };

      return {
        ...automation,
        trackedLinks: automation.trackedLinks.map((link) => ({
          ...link,
          trackedUrl: buildTrackedUrl(link.slug),
        })),
        reportUrl: automation.reportShareSlug
          ? buildReportUrl(automation.reportShareSlug)
          : null,
        analytics: {
          ...item,
          ctr: calculateCtr(item.clicks, item.sent),
        },
      };
    }),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can create campaigns" },
      { status: 403 }
    );
  }

  const workspaceId = context.workspaceId;

  const body = await request.json();
  const parsed = createAutomationSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: "Invalid input",
        details: parsed.error.flatten(),
      },
      { status: 400 }
    );
  }

  const configurationIssues = validateAutomationConfiguration(parsed.data);
  if (configurationIssues.length > 0) {
    return configurationError(configurationIssues);
  }

  const requestedInstagramAccountId =
    parsed.data.instagramAccountId && parsed.data.instagramAccountId !== "all"
      ? parsed.data.instagramAccountId
      : null;

  const [workspace, instagramAccount] = await Promise.all([
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true },
    }),
    requestedInstagramAccountId
      ? prisma.instagramAccount.findFirst({
          where: { id: requestedInstagramAccountId, workspaceId },
        })
      : prisma.instagramAccount.findFirst({
          where: { workspaceId },
          orderBy: { connectedAt: "desc" },
        }),
  ]);

  if (!workspace) {
    return NextResponse.json(
      { success: false, error: "Workspace not found" },
      { status: 404 }
    );
  }

  if (!instagramAccount) {
    return NextResponse.json(
      { success: false, error: "Connect Instagram before creating campaigns" },
      { status: 400 }
    );
  }

  const isInboundDm = parsed.data.triggerType === "INBOUND_DM";
  const isSpecificPost =
    !isInboundDm && !parsed.data.pendingNextReel && !parsed.data.matchAnyPost;

  if (isSpecificPost && parsed.data.isActive && parsed.data.postId) {
    const inaccessible = await postAccessibilityError(
      instagramAccount,
      parsed.data.postId
    );
    if (inaccessible) return inaccessible;
  }

  const { trackedDestinationUrl, secondaryDestinationUrl, secondaryButtonLabel } =
    parsed.data;

  // The primary link's button title comes from `linkButtonLabel`; the second
  // link stores its own button title in the tracked link's `label` field.
  const linkCreates: {
    workspaceId: string;
    slug: string;
    label: string;
    destinationUrl: string;
  }[] = [];
  if (trackedDestinationUrl) {
    linkCreates.push({
      workspaceId,
      slug: generateTrackedLinkSlug(),
      label: "Primary campaign link",
      destinationUrl: trackedDestinationUrl,
    });
  }
  if (secondaryDestinationUrl) {
    linkCreates.push({
      workspaceId,
      slug: generateTrackedLinkSlug(),
      label: secondaryButtonLabel?.trim() || "Open link",
      destinationUrl: secondaryDestinationUrl,
    });
  }

  const pendingNextReel = isInboundDm ? false : parsed.data.pendingNextReel;
  const matchAnyPost = isInboundDm ? false : parsed.data.matchAnyPost;
  const matchAnyWord = isInboundDm ? false : parsed.data.matchAnyWord;
  const openingDmEnabled = isInboundDm
    ? false
    : parsed.data.openingDmEnabled;
  const publicReplyList = (
    parsed.data.publicReplyMessages.length > 0
      ? parsed.data.publicReplyMessages
      : parsed.data.publicReplyMessage
        ? [parsed.data.publicReplyMessage]
        : []
  )
    .map((m) => m.trim())
    .filter(Boolean);

  const createArgs: Prisma.AutomationCreateArgs = {
    data: {
      name: parsed.data.name,
      goal: parsed.data.goal,
      triggerType: parsed.data.triggerType,
      // A next-reel campaign has no post yet; the cron binds it once a reel is posted.
      postId: isSpecificPost ? parsed.data.postId : null,
      postUrl: isSpecificPost ? parsed.data.postUrl : null,
      pendingNextReel,
      matchAnyPost,
      keywords: matchAnyWord ? [] : parsed.data.keywords,
      matchAnyWord,
      dmMessage: parsed.data.dmMessage,
      openingDmEnabled,
      openingDmMessage: openingDmEnabled
        ? parsed.data.openingDmMessage || null
        : null,
      openingDmButtonLabel: openingDmEnabled
        ? parsed.data.openingDmButtonLabel || null
        : null,
      linkButtonLabel: parsed.data.linkButtonLabel || null,
      requireFollow: isInboundDm ? false : parsed.data.requireFollow,
      followPromptMessage: !isInboundDm && parsed.data.requireFollow
        ? parsed.data.followPromptMessage || null
        : null,
      followPromptButtonLabel: !isInboundDm && parsed.data.requireFollow
        ? parsed.data.followPromptButtonLabel || null
        : null,
      followUpEnabled: isInboundDm ? false : parsed.data.followUpEnabled,
      followUpMessage: !isInboundDm && parsed.data.followUpEnabled
        ? parsed.data.followUpMessage || null
        : null,
      publicReplyEnabled: isInboundDm ? false : parsed.data.publicReplyEnabled,
      publicReplyMessages: !isInboundDm && parsed.data.publicReplyEnabled
        ? publicReplyList
        : [],
      publicReplyMessage: !isInboundDm && parsed.data.publicReplyEnabled
        ? publicReplyList[0] ?? parsed.data.publicReplyMessage ?? null
        : null,
      isActive: parsed.data.isActive,
      wholeWordMatch: parsed.data.wholeWordMatch,
      workspaceId,
      instagramAccountId: instagramAccount.id,
      reportShareSlug: generateReportShareSlug(),
      ...(linkCreates.length > 0
        ? { trackedLinks: { create: linkCreates } }
        : {}),
    },
    include: {
      trackedLinks: true,
    },
  };

  let automation;
  if (isInboundDm && parsed.data.isActive) {
    const result = await prisma.$transaction(async (tx) => {
      await lockInboundKeywordAccount(tx, instagramAccount.id);
      const conflicts = await findInboundKeywordConflicts(
        {
          instagramAccountId: instagramAccount.id,
          keywords: parsed.data.keywords,
        },
        tx
      );
      if (conflicts.length > 0) return { automation: null, conflicts };
      return {
        automation: await tx.automation.create(createArgs),
        conflicts: [] as InboundKeywordConflicts,
      };
    });
    if (!result.automation) {
      return inboundKeywordConflictResponse(result.conflicts);
    }
    automation = result.automation;
  } else {
    automation = await prisma.automation.create(createArgs);
  }

  return NextResponse.json(
    { success: true, data: automation },
    { status: 201 }
  );
}

export async function PATCH(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can update campaigns" },
      { status: 403 }
    );
  }

  const workspaceId = context.workspaceId;

  const automationId = request.nextUrl.searchParams.get("id");
  if (!automationId) {
    return NextResponse.json(
      { success: false, error: "Missing campaign ID" },
      { status: 400 }
    );
  }

  const body = await request.json();
  const parsed = updateAutomationSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: "Invalid input",
        details: parsed.error.flatten(),
      },
      { status: 400 }
    );
  }

  const existing = await prisma.automation.findFirst({
    where: { id: automationId, workspaceId },
    include: {
      instagramAccount: {
        select: { username: true, accessToken: true },
      },
    },
  });

  if (!existing) {
    return NextResponse.json(
      { success: false, error: "Campaign not found" },
      { status: 404 }
    );
  }

  const effectiveConfiguration: AutomationConfiguration = {
    triggerType: parsed.data.triggerType ?? existing.triggerType,
    postId:
      parsed.data.postId !== undefined ? parsed.data.postId : existing.postId,
    pendingNextReel:
      parsed.data.pendingNextReel ?? existing.pendingNextReel,
    matchAnyPost: parsed.data.matchAnyPost ?? existing.matchAnyPost,
    keywords: parsed.data.keywords ?? existing.keywords,
    matchAnyWord: parsed.data.matchAnyWord ?? existing.matchAnyWord,
    openingDmEnabled:
      parsed.data.openingDmEnabled ?? existing.openingDmEnabled,
    openingDmMessage:
      parsed.data.openingDmMessage !== undefined
        ? parsed.data.openingDmMessage
        : existing.openingDmMessage,
    openingDmButtonLabel:
      parsed.data.openingDmButtonLabel !== undefined
        ? parsed.data.openingDmButtonLabel
        : existing.openingDmButtonLabel,
  };
  if (effectiveConfiguration.triggerType === "INBOUND_DM") {
    Object.assign(effectiveConfiguration, {
      postId: null,
      pendingNextReel: false,
      matchAnyPost: false,
      matchAnyWord: false,
      openingDmEnabled: false,
      openingDmMessage: null,
      openingDmButtonLabel: null,
    });
  }
  const configurationIssues = validateAutomationConfiguration(
    effectiveConfiguration
  );
  if (configurationIssues.length > 0) {
    return configurationError(configurationIssues);
  }

  const effectiveIsActive = parsed.data.isActive ?? existing.isActive;
  const isSpecificCommentPost =
    effectiveConfiguration.triggerType === "COMMENT" &&
    !effectiveConfiguration.matchAnyPost &&
    !effectiveConfiguration.pendingNextReel &&
    Boolean(effectiveConfiguration.postId);
  const activating = parsed.data.isActive === true && !existing.isActive;
  const triggerTargetChanged =
    (parsed.data.triggerType !== undefined &&
      parsed.data.triggerType !== existing.triggerType) ||
    (parsed.data.postId !== undefined &&
      parsed.data.postId !== existing.postId) ||
    (parsed.data.matchAnyPost !== undefined &&
      parsed.data.matchAnyPost !== existing.matchAnyPost) ||
    (parsed.data.pendingNextReel !== undefined &&
      parsed.data.pendingNextReel !== existing.pendingNextReel);
  if (
    isSpecificCommentPost &&
    effectiveIsActive &&
    (activating || triggerTargetChanged) &&
    effectiveConfiguration.postId
  ) {
    const inaccessible = await postAccessibilityError(
      existing.instagramAccount,
      effectiveConfiguration.postId
    );
    if (inaccessible) return inaccessible;
  }

  const {
    trackedDestinationUrl,
    secondaryDestinationUrl,
    secondaryButtonLabel,
    ...automationData
  } = parsed.data;

  if (effectiveConfiguration.triggerType === "INBOUND_DM") {
    Object.assign(automationData, inboundDmOnlyFields());
  }

  // Keep dependent fields consistent: any-word clears keywords; a disabled
  // opening DM clears its message and button.
  if (automationData.matchAnyWord === true) automationData.keywords = [];
  if (automationData.openingDmEnabled === false) {
    automationData.openingDmMessage = null;
    automationData.openingDmButtonLabel = null;
  }
  if (automationData.requireFollow === false) {
    automationData.followPromptMessage = null;
    automationData.followPromptButtonLabel = null;
  }
  if (automationData.followUpEnabled === false) {
    automationData.followUpMessage = null;
  }
  // Any-post / next-reel campaigns carry no specific post.
  if (automationData.matchAnyPost === true || automationData.pendingNextReel === true) {
    automationData.postId = null;
    automationData.postUrl = null;
  }
  // Keep the public-reply variations list and the legacy single field in sync.
  if (automationData.publicReplyMessages !== undefined) {
    const list = automationData.publicReplyMessages
      .map((m) => m.trim())
      .filter(Boolean);
    automationData.publicReplyMessages = list;
    automationData.publicReplyMessage = list[0] ?? null;
  }
  if (automationData.publicReplyEnabled === false) {
    automationData.publicReplyMessages = [];
    automationData.publicReplyMessage = null;
  }

  let updated;
  if (
    effectiveConfiguration.triggerType === "INBOUND_DM" &&
    effectiveIsActive
  ) {
    const result = await prisma.$transaction(async (tx) => {
      await lockInboundKeywordAccount(tx, existing.instagramAccountId);
      const conflicts = await findInboundKeywordConflicts(
        {
          instagramAccountId: existing.instagramAccountId,
          keywords: effectiveConfiguration.keywords,
          excludeAutomationId: existing.id,
        },
        tx
      );
      if (conflicts.length > 0) return { updated: null, conflicts };
      return {
        updated: await tx.automation.update({
          where: { id: automationId },
          data: automationData,
        }),
        conflicts: [] as InboundKeywordConflicts,
      };
    });
    if (!result.updated) {
      return inboundKeywordConflictResponse(result.conflicts);
    }
    updated = result.updated;
  } else {
    updated = await prisma.automation.update({
      where: { id: automationId },
      data: automationData,
    });
  }

  // Update, create, or clear the campaign's primary tracked link when a
  // destination URL was supplied. `undefined` means "leave it alone".
  if (trackedDestinationUrl !== undefined && trackedDestinationUrl !== null) {
    const primaryLink = await prisma.trackedLink.findFirst({
      where: { automationId },
      orderBy: { createdAt: "asc" },
    });

    if (trackedDestinationUrl === "") {
      if (primaryLink) {
        await prisma.trackedLink.delete({ where: { id: primaryLink.id } });
      }
    } else if (primaryLink) {
      await prisma.trackedLink.update({
        where: { id: primaryLink.id },
        data: { destinationUrl: trackedDestinationUrl },
      });
    } else {
      await prisma.trackedLink.create({
        data: {
          workspaceId,
          automationId,
          slug: generateTrackedLinkSlug(),
          label: "Primary campaign link",
          destinationUrl: trackedDestinationUrl,
        },
      });
    }
  }

  // Update, create, or clear the campaign's second tracked link. It is always
  // the link at index [1] (ordered by createdAt), and its `label` holds the
  // second button's title.
  if (secondaryDestinationUrl !== undefined && secondaryDestinationUrl !== null) {
    const links = await prisma.trackedLink.findMany({
      where: { automationId },
      orderBy: { createdAt: "asc" },
    });
    const secondaryLink = links[1];
    const secondaryLabel = secondaryButtonLabel?.trim() || "Open link";

    if (secondaryDestinationUrl === "") {
      if (secondaryLink) {
        await prisma.trackedLink.delete({ where: { id: secondaryLink.id } });
      }
    } else if (secondaryLink) {
      await prisma.trackedLink.update({
        where: { id: secondaryLink.id },
        data: { destinationUrl: secondaryDestinationUrl, label: secondaryLabel },
      });
    } else {
      await prisma.trackedLink.create({
        data: {
          workspaceId,
          automationId,
          slug: generateTrackedLinkSlug(),
          label: secondaryLabel,
          destinationUrl: secondaryDestinationUrl,
        },
      });
    }
  }

  return NextResponse.json({ success: true, data: updated });
}

export async function DELETE(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can delete campaigns" },
      { status: 403 }
    );
  }

  const workspaceId = context.workspaceId;

  const automationId = request.nextUrl.searchParams.get("id");
  if (!automationId) {
    return NextResponse.json(
      { success: false, error: "Missing campaign ID" },
      { status: 400 }
    );
  }

  const existing = await prisma.automation.findFirst({
    where: { id: automationId, workspaceId },
  });

  if (!existing) {
    return NextResponse.json(
      { success: false, error: "Campaign not found" },
      { status: 404 }
    );
  }

  await prisma.automation.delete({ where: { id: automationId } });

  return NextResponse.json({ success: true, data: { deleted: true } });
}
