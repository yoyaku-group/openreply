import { NextRequest, NextResponse } from "next/server";
import { purgeExpiredCopyGenerations } from "@/lib/copywriter/service";

/**
 * Purge the AI copywriter queue: CopyGeneration rows older than 90 days
 * leave the table. Driven by the same cron rail as the other /api/cron
 * routes (deploy/cron.sh). Terminal audit data lives long enough for S4
 * analysis; nothing here is customer content — inputs are public shop facts.
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

  const purged = await purgeExpiredCopyGenerations();
  return NextResponse.json({ success: true, data: { purged } });
}
