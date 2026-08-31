import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { probeInstagramAccountCapabilities } from "@/lib/meta/capabilities";

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET || process.env.NEXTAUTH_SECRET;
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const accounts = await prisma.instagramAccount.findMany({
    where: { archivedAt: null },
    select: { id: true, workspaceId: true },
  });
  const results = await Promise.all(
    accounts.map((account) =>
      probeInstagramAccountCapabilities(account.id, {
        workspaceId: account.workspaceId,
      }),
    ),
  );

  return NextResponse.json({
    success: true,
    data: {
      checked: results.length,
      commentsReady: results.filter((row) => row.features.comments.ready)
        .length,
      messagesReady: results.filter((row) => row.features.messages.ready)
        .length,
      errors: results.filter((row) => row.probeError).length,
    },
  });
}
