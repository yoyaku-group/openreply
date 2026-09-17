import { NextRequest, NextResponse } from "next/server";
import { attachPendingNextReels } from "@/lib/release-sync/attach-pending-automations";

/**
 * Binds "next post or reel" campaigns to a real post.
 *
 * Instagram sends no webhook when a new media is published, so the sweep in
 * lib/release-sync/attach-pending-automations.ts polls for every campaign
 * awaiting the creator's next post or reel and attaches it to the earliest
 * eligible media. The worker poll runs the same sweep every few minutes; this
 * route is the self-hosted/Vercel cron driver and stays as the safety net.
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

  const summary = await attachPendingNextReels();
  return NextResponse.json({ success: true, data: summary });
}
