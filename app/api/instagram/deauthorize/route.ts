import { NextResponse } from "next/server";
import { processMetaDeauthorization } from "@/lib/meta/data-controls";
import { readMetaSignedRequest } from "@/lib/meta/signed-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    { status: "ready", callback: "instagram_deauthorization" },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const verified = await readMetaSignedRequest(request);
  if (!verified) {
    return NextResponse.json({ error: "Invalid signed request" }, { status: 401 });
  }

  const result = await processMetaDeauthorization(verified.payload.userId);
  return NextResponse.json(
    { success: true, disconnected: result.disconnected },
    { headers: { "Cache-Control": "no-store" } },
  );
}
