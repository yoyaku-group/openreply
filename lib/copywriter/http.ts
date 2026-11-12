import { NextResponse } from "next/server";
import { isCopywriterBridgeAuthorized } from "@/lib/copywriter/security";
import { CopywriterError } from "@/lib/copywriter/service";

export const COPYWRITER_NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
};

export function requireCopywriterBridge(request: Request): NextResponse | null {
  if (isCopywriterBridgeAuthorized(request)) return null;
  return NextResponse.json(
    { success: false, error: "Unauthorized" },
    { status: 401, headers: COPYWRITER_NO_STORE_HEADERS }
  );
}

export function copywriterJson(data: unknown, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, {
    ...init,
    headers: { ...COPYWRITER_NO_STORE_HEADERS, ...init?.headers },
  });
}

export function copywriterErrorResponse(error: unknown): NextResponse {
  if (error instanceof CopywriterError) {
    return copywriterJson(
      { success: false, error: error.code },
      { status: error.status }
    );
  }
  console.error("[copywriter bridge] internal operation failed", {
    errorType: error instanceof Error ? error.name : typeof error,
  });
  return copywriterJson(
    { success: false, error: "INTERNAL_ERROR" },
    { status: 500 }
  );
}
