import { NextResponse } from "next/server";
import { CopywriterError } from "@/lib/copywriter/service";
import { COPYWRITER_NO_STORE_HEADERS } from "@/lib/copywriter/http";
import { canReadLab, canWriteLab } from "@/lib/copywriter/lab-access";
import { getCurrentWorkspaceContext } from "@/lib/workspace-access";
import type { WorkspaceContext } from "@/lib/workspace-access";
import { prisma } from "@/lib/db/client";

/**
 * Shared session-auth plumbing for the /api/copywriter/* lab routes:
 * dashboard session auth, workspace-scoped, editor may read, owner writes
 * (with the documented allowlist fallback), stable error codes.
 */

export function labJson(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, {
    status,
    headers: COPYWRITER_NO_STORE_HEADERS,
  });
}

export function labError(error: unknown): NextResponse {
  if (error instanceof CopywriterError) {
    return labJson({ success: false, error: error.code }, error.status);
  }
  console.error("[copywriter lab] operation failed", {
    errorType: error instanceof Error ? error.name : typeof error,
  });
  return labJson({ success: false, error: "INTERNAL_ERROR" }, 500);
}

type Guard = { ok: true; context: WorkspaceContext } | { ok: false; response: NextResponse };

export async function requireLabReader(): Promise<Guard> {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return { ok: false, response: labJson({ success: false, error: "Unauthorized" }, 401) };
  }
  if (!canReadLab(context.role)) {
    return { ok: false, response: labJson({ success: false, error: "FORBIDDEN" }, 403) };
  }
  return { ok: true, context };
}

export async function requireLabWriter(): Promise<Guard> {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return { ok: false, response: labJson({ success: false, error: "Unauthorized" }, 401) };
  }
  if (!(await canWriteLab(context))) {
    return { ok: false, response: labJson({ success: false, error: "FORBIDDEN" }, 403) };
  }
  return { ok: true, context };
}

/** The version author recorded on every lab write. */
export async function authorEmailFor(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  return user?.email ?? "unknown@openreply";
}
