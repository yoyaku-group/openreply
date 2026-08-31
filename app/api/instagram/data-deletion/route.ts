import { NextResponse } from "next/server";
import { getRequestBaseUrl } from "@/lib/env";
import { processMetaDataDeletionRequest } from "@/lib/meta/data-controls";
import { readMetaSignedRequest } from "@/lib/meta/signed-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    { status: "ready", callback: "instagram_data_deletion" },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const verified = await readMetaSignedRequest(request);
  if (!verified) {
    return NextResponse.json({ error: "Invalid signed request" }, { status: 401 });
  }

  const receipt = await processMetaDataDeletionRequest({
    platformUserId: verified.payload.userId,
    signedRequest: verified.signedRequest,
  });
  const baseUrl = getRequestBaseUrl({
    nextUrl: new URL(request.url),
  });

  return NextResponse.json(
    {
      url: `${baseUrl}/api/instagram/data-deletion/${receipt.confirmationCode}`,
      confirmation_code: receipt.confirmationCode,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
