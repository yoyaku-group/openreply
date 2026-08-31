import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUserId } from "@/lib/auth";
import { ACTIVE_WORKSPACE_COOKIE, createOwnedWorkspace } from "@/lib/workspace";

const createWorkspaceSchema = z.object({
  name: z.string().trim().min(2).max(80),
});

export async function POST(request: NextRequest) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const parsed = createWorkspaceSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "Workspace name must be 2-80 characters" },
      { status: 400 },
    );
  }

  const workspace = await createOwnedWorkspace(userId, parsed.data.name);
  const response = NextResponse.json(
    { success: true, data: { id: workspace.id, name: workspace.name } },
    { status: 201 },
  );
  response.cookies.set(ACTIVE_WORKSPACE_COOKIE, workspace.id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return response;
}
