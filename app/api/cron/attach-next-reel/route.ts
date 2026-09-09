import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getUserMedia, type InstagramMedia } from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";
import { selectMediaForPendingAutomation } from "@/lib/release-sync/media-binding";

/**
 * Binds "next post or reel" campaigns to a real post.
 *
 * Instagram sends no webhook when a new media is published, so we poll: for
 * every campaign awaiting the creator's next post or reel, find the earliest
 * eligible media that was posted after the campaign was created and attach the
 * campaign to it. Runs on a schedule (see vercel.json) — the campaign goes
 * live within one cron interval of the media being posted.
 */

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET || process.env.NEXTAUTH_SECRET;

  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  if (process.env.ATTACH_NEXT_REEL_ENABLED !== "true") {
    console.info(
      "[attach-next-reel] run",
      JSON.stringify({ enabled: false, pending: 0, checked: 0, bound: 0 })
    );
    return NextResponse.json({
      success: true,
      data: { enabled: false, checked: 0, bound: 0, failedAccounts: 0 },
    });
  }

  const pending = await prisma.automation.findMany({
    where: { pendingNextReel: true },
    include: { instagramAccount: true },
  });
  console.info(
    "[attach-next-reel] pending",
    JSON.stringify({ enabled: true, pending: pending.length })
  );

  // Group by connected account so we fetch each account's media only once.
  const byAccount = new Map<
    string,
    { account: (typeof pending)[number]["instagramAccount"]; automations: typeof pending }
  >();
  for (const automation of pending) {
    const key = automation.instagramAccountId;
    const entry = byAccount.get(key);
    if (entry) entry.automations.push(automation);
    else byAccount.set(key, { account: automation.instagramAccount, automations: [automation] });
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
        })
      );
      continue;
    }

    console.info(
      "[attach-next-reel] account_checked",
      JSON.stringify({
        accountId: account.id,
        campaigns: automations.length,
        media: media.length,
      })
    );

    for (const automation of automations) {
      const target = selectMediaForPendingAutomation(
        media,
        automation.createdAt,
        automation.catnoTag
      );
      if (!target) continue;

      await prisma.automation.update({
        where: { id: automation.id },
        data: {
          postId: target.id,
          postUrl: target.permalink ?? null,
          pendingNextReel: false,
        },
      });
      console.info(
        "[attach-next-reel] bound",
        JSON.stringify({
          automationId: automation.id,
          mediaId: target.id,
          mediaProductType: target.media_product_type ?? null,
          publishedAt: target.timestamp,
        })
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
    })
  );
  return NextResponse.json({
    success: true,
    data: {
      enabled: true,
      pending: pending.length,
      accounts: byAccount.size,
      checked,
      bound,
      failedAccounts: failures.length,
    },
  });
}
