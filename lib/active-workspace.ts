import { cookies, headers } from "next/headers";
import type { Workspace, WorkspaceRole } from "@/app/generated/prisma/client";
import {
  ACTIVE_WORKSPACE_COOKIE,
  DomainWorkspaceNotFoundError,
  getHostWorkspaceTarget,
  resolveActiveWorkspace,
  resolveHostWorkspaceId,
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
  const headerStore = await headers();
  const host = headerStore.get("host");
  const hostPinned = Boolean(getHostWorkspaceTarget(host));
  let pinnedWorkspaceId: string | null = null;
  try {
    pinnedWorkspaceId = await resolveHostWorkspaceId(host);
  } catch (error) {
    if (error instanceof DomainWorkspaceNotFoundError && hostPinned) return null;
    throw error;
  }
  const preferred = pinnedWorkspaceId ?? store.get(ACTIVE_WORKSPACE_COOKIE)?.value ?? null;
  return resolveActiveWorkspace(userId, preferred, hostPinned);
}
