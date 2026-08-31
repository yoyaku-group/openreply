import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ code: string }> },
) {
  const { code } = await context.params;
  const receipt = await prisma.metaDataDeletionRequest.findUnique({
    where: { confirmationCode: code },
    select: {
      confirmationCode: true,
      status: true,
      requestedAt: true,
      completedAt: true,
    },
  });
  if (!receipt) {
    return NextResponse.json({ error: "Unknown confirmation code" }, { status: 404 });
  }

  return NextResponse.json(
    {
      confirmation_code: receipt.confirmationCode,
      status: receipt.status,
      requested_at: receipt.requestedAt,
      completed_at: receipt.completedAt,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
