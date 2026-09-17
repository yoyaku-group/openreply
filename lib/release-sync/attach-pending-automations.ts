/**
 * Binds "next post or reel" campaigns to real media.
 *
 * Instagram sends no webhook when a new media is published, so binding has two
 * drivers:
 *   1. JIT bind — when the first comment webhook arrives for a media, attach the
 *      account's pending campaigns right then, so an armed campaign goes live in
 *      seconds instead of waiting for the next poll.
 *   2. Sweep — a scheduled pass (cron route plus the worker poll) that attaches
 *      every pending campaign to its earliest eligible media. Covers campaigns
 *      whose post gets no comments, or whose webhook was missed.
 *
 * Eligibility (see selectMediaForPendingAutomation) is strict: media must have
 * been published after the campaign was created, be a FEED post or a REEL, and
 * match the campaign's catalogue tag when one is set. All binds are atomic
 * (updateMany + pendingNextReel guard) so two drivers racing over the same
 * campaign can never both claim it.
 */

import { prisma } from "@/lib/db/client";
import {
  getMediaById,
  getUserMedia,
  type InstagramMedia,
} from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";
import { selectMediaForPendingAutomation } from "@/lib/release-sync/media-binding";

export interface AttachSummary {
  enabled: boolean;
  pending: number;
  accounts: number;
  checked: number;
  bound: number;
  failedAccounts: number;
}

export interface PendingAutomation {
  id: string;
  name: string;
  createdAt: Date;
  catnoTag: string | null;
}

export interface MediaBinding {
  automationId: string;
  mediaId: string;
  postUrl: string | null;
}

/** The self-hosted binder runs only when explicitly enabled. */
export function isAttachBinderEnabled(): boolean {
  return process.env.ATTACH_NEXT_REEL_ENABLED === "true";
}

/**
 * Pure: which of these pending campaigns may bind to this media. Every
 * automation is evaluated independently, so two campaigns armed on the same
 * account both bind to the same next post (ManyChat-style "next" semantics
 * differ, but existing production campaigns already relied on this).
 */
export function selectBindingsForMedia(
  automations: PendingAutomation[],
  media: InstagramMedia,
): MediaBinding[] {
  return automations.flatMap((automation) => {
    const target = selectMediaForPendingAutomation(
      [media],
      automation.createdAt,
      automation.catnoTag,
    );
    if (!target) return [];
    return [
      {
        automationId: automation.id,
        mediaId: target.id,
        postUrl: target.permalink ?? null,
      },
    ];
  });
}

/**
 * Claim a pending campaign for a media. The `pendingNextReel: true` guard makes
 * the bind atomic against concurrent drivers (cron, worker poll, JIT comment).
 */
async function bindPendingAutomation(binding: MediaBinding): Promise<boolean> {
  const result = await prisma.automation.updateMany({
    where: { id: binding.automationId, pendingNextReel: true },
    data: {
      postId: binding.mediaId,
      postUrl: binding.postUrl,
      pendingNextReel: false,
    },
  });
  return result.count === 1;
}

/**
 * JIT bind: attach the account's pending campaigns to the media a comment just
 * arrived on. Returns how many campaigns were bound. Never throws — a failed
 * lookup must not block processing of the comment itself.
 */
export async function bindPendingAutomationsForMedia(input: {
  instagramAccountId: string;
  mediaId: string;
}): Promise<number> {
  if (!isAttachBinderEnabled()) return 0;

  let pending;
  try {
    pending = await prisma.automation.findMany({
      where: {
        pendingNextReel: true,
        instagramAccount: { instagramId: input.instagramAccountId },
      },
      select: {
        id: true,
        name: true,
        createdAt: true,
        catnoTag: true,
        instagramAccountId: true,
        instagramAccount: { select: { accessToken: true } },
      },
    });
  } catch (error) {
    console.error(
      "[attach-next-reel] jit_lookup_failed",
      JSON.stringify({
        accountId: input.instagramAccountId,
        mediaId: input.mediaId,
        error: error instanceof Error ? error.name : "unknown",
      }),
    );
    return 0;
  }

  if (pending.length === 0) return 0;
  const accessToken = pending[0].instagramAccount?.accessToken;
  if (!accessToken) return 0;

  let media: InstagramMedia;
  try {
    media = await getMediaById(decryptToken(accessToken), input.mediaId);
  } catch (error) {
    console.error(
      "[attach-next-reel] jit_media_fetch_failed",
      JSON.stringify({
        accountId: input.instagramAccountId,
        mediaId: input.mediaId,
        error: error instanceof Error ? error.name : "unknown",
      }),
    );
    return 0;
  }

  let bound = 0;
  for (const binding of selectBindingsForMedia(pending, media)) {
    if (!(await bindPendingAutomation(binding))) continue;
    bound += 1;
    console.info(
      "[attach-next-reel] bound_jit",
      JSON.stringify({
        automationId: binding.automationId,
        mediaId: binding.mediaId,
        mediaProductType: media.media_product_type ?? null,
        publishedAt: media.timestamp,
      }),
    );
  }
  return bound;
}

/**
 * Sweep every pending campaign and bind it to its earliest eligible media.
 * Used by the cron route and the worker poll.
 */
export async function attachPendingNextReels(): Promise<AttachSummary> {
  if (!isAttachBinderEnabled()) {
    console.info(
      "[attach-next-reel] run",
      JSON.stringify({ enabled: false, pending: 0, checked: 0, bound: 0 }),
    );
    return {
      enabled: false,
      pending: 0,
      accounts: 0,
      checked: 0,
      bound: 0,
      failedAccounts: 0,
    };
  }

  const pending = await prisma.automation.findMany({
    where: { pendingNextReel: true },
    include: { instagramAccount: true },
  });
  console.info(
    "[attach-next-reel] pending",
    JSON.stringify({ enabled: true, pending: pending.length }),
  );

  // Group by connected account so we fetch each account's media only once.
  const byAccount = new Map<
    string,
    {
      account: (typeof pending)[number]["instagramAccount"];
      automations: typeof pending;
    }
  >();
  for (const automation of pending) {
    const key = automation.instagramAccountId;
    const entry = byAccount.get(key);
    if (entry) entry.automations.push(automation);
    else
      byAccount.set(key, {
        account: automation.instagramAccount,
        automations: [automation],
      });
  }

  let bound = 0;
  let checked = 0;
  const failures: string[] = [];

  for (const { account, automations } of byAccount.values()) {
    checked += automations.length;
    if (!account?.accessToken) continue;

    let media: InstagramMedia[];
    try {
      const token = decryptToken(account.accessToken);
      media = await getUserMedia(token, 25);
    } catch (err) {
      failures.push(account.id);
      console.error(
        "[attach-next-reel] media_fetch_failed",
        JSON.stringify({
          accountId: account.id,
          campaigns: automations.length,
          error: err instanceof Error ? err.name : "unknown",
        }),
      );
      continue;
    }

    console.info(
      "[attach-next-reel] account_checked",
      JSON.stringify({
        accountId: account.id,
        campaigns: automations.length,
        media: media.length,
      }),
    );

    for (const automation of automations) {
      const target = selectMediaForPendingAutomation(
        media,
        automation.createdAt,
        automation.catnoTag,
      );
      if (!target) continue;
      const didBind = await bindPendingAutomation({
        automationId: automation.id,
        mediaId: target.id,
        postUrl: target.permalink ?? null,
      });
      if (!didBind) continue;
      console.info(
        "[attach-next-reel] bound",
        JSON.stringify({
          automationId: automation.id,
          mediaId: target.id,
          mediaProductType: target.media_product_type ?? null,
          publishedAt: target.timestamp,
        }),
      );
      bound += 1;
    }
  }

  console.info(
    "[attach-next-reel] run_complete",
    JSON.stringify({
      enabled: true,
      pending: pending.length,
      accounts: byAccount.size,
      checked,
      bound,
      failedAccounts: failures.length,
    }),
  );

  return {
    enabled: true,
    pending: pending.length,
    accounts: byAccount.size,
    checked,
    bound,
    failedAccounts: failures.length,
  };
}
