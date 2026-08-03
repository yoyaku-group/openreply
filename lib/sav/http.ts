import { NextResponse } from "next/server";
import { isSavBridgeAuthorized } from "@/lib/sav/security";
import { SavBridgeError } from "@/lib/sav/service";

export const SAV_NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
};

export function requireSavBridge(request: Request): NextResponse | null {
  if (isSavBridgeAuthorized(request)) return null;
  return NextResponse.json(
    { success: false, error: "Unauthorized" },
    { status: 401, headers: SAV_NO_STORE_HEADERS }
  );
}

export function savJson(data: unknown, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, {
    ...init,
    headers: { ...SAV_NO_STORE_HEADERS, ...init?.headers },
  });
}

export function savErrorResponse(error: unknown): NextResponse {
  if (error instanceof SavBridgeError) {
    return savJson(
      { success: false, error: error.code },
      { status: error.status }
    );
  }
  console.error("[SAV bridge] internal operation failed", {
    errorType: error instanceof Error ? error.name : typeof error,
  });
  return savJson(
    { success: false, error: "INTERNAL_ERROR" },
    { status: 500 }
  );
}
