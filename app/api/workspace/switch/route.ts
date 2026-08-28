import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { getCurrentUserId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import {
  ACTIVE_WORKSPACE_COOKIE,
  resolveHostWorkspaceId,
} from "@/lib/workspace";

const switchSchema = z.object({
  workspaceId: z.string().min(1),
});

export async function POST(request: NextRequest) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const parsed = switchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "workspaceId required" },
      { status: 400 }
    );
  }

  const pinnedWorkspaceId = await resolveHostWorkspaceId(request.headers.get("host"));
  if (pinnedWorkspaceId && parsed.data.workspaceId !== pinnedWorkspaceId) {
    return NextResponse.json(
      { success: false, error: "This host is pinned to another workspace" },
      { status: 403 }
    );
  }

  const membership = await prisma.workspaceMember.findFirst({
    where: { userId, workspaceId: parsed.data.workspaceId },
    select: { id: true },
  });
  if (!membership) {
    return NextResponse.json(
      { success: false, error: "Not a member of this workspace" },
      { status: 403 }
    );
  }

  const store = await cookies();
  store.set(ACTIVE_WORKSPACE_COOKIE, parsed.data.workspaceId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    secure: process.env.NODE_ENV === "production",
  });

  return NextResponse.json({
    success: true,
    data: { workspaceId: parsed.data.workspaceId },
  });
}
