import { createHmac, timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";
import { exportPublicationMediaPage } from "@/lib/publications/meta-export";

function configuredSecret(): string {
  return process.env.PUBLICATION_EXPORT_SECRET || process.env.CRON_SECRET || "";
}

function authorized(request: Request, secret: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  if (!secret || secret.length < 32 || !header.startsWith("Bearer ")) return false;
  const supplied = header.slice("Bearer ".length);
  const left = Buffer.from(supplied);
  const right = Buffer.from(secret);
  return left.length === right.length && timingSafeEqual(left, right);
}

function signedJson(payload: unknown, secret: string, status = 200): Response {
  const body = JSON.stringify(payload);
  const timestamp = new Date().toISOString();
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return new Response(body, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store, max-age=0",
      "x-yoyaku-timestamp": timestamp,
      "x-yoyaku-signature": `sha256=${signature}`,
    },
  });
}

export async function GET(request: NextRequest) {
  const secret = configuredSecret();
  if (!authorized(request, secret)) {
    return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const account = (request.nextUrl.searchParams.get("account") ?? "").trim().toLowerCase();
  const after = request.nextUrl.searchParams.get("after");
  const rawLimit = Number.parseInt(request.nextUrl.searchParams.get("limit") ?? "100", 10);
  if (!/^[a-z0-9._-]{2,80}$/.test(account)) {
    return signedJson({ success: false, error: "invalid_account" }, secret, 400);
  }
  if (after && !/^[A-Za-z0-9_=-]{1,500}$/.test(after)) {
    return signedJson({ success: false, error: "invalid_cursor" }, secret, 400);
  }
  const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 100;

  try {
    const page = await exportPublicationMediaPage(account, after, limit);
    return signedJson({
      success: true,
      data: {
        account_owner: account,
        media: page.media,
        next_cursor: page.next_cursor,
        complete: page.next_cursor === null,
      },
    }, secret);
  } catch (error) {
    const missing = error instanceof Error && error.message === "ACCOUNT_NOT_FOUND";
    if (!missing) console.error("[publication-export] Meta media export failed", error);
    return signedJson(
      { success: false, error: missing ? "account_not_found" : "meta_export_failed" },
      secret,
      missing ? 404 : 502
    );
  }
}
