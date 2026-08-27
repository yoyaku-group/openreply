import { cookies } from "next/headers";
import type { Workspace, WorkspaceRole } from "@/app/generated/prisma/client";
import {
  ACTIVE_WORKSPACE_COOKIE,
  resolveActiveWorkspace,
} from "@/lib/workspace";

/**
 * Request-scoped active-workspace resolution: reads the switcher cookie and
 * validates it against the user's memberships. Only call from route handlers
 * and server components — cookies() throws outside a request.
 */
export async function getActiveWorkspace(
  userId: string
): Promise<{ workspace: Workspace; role: WorkspaceRole } | null> {
  const store = await cookies();
  const preferred = store.get(ACTIVE_WORKSPACE_COOKIE)?.value ?? null;
  return resolveActiveWorkspace(userId, preferred);
}
