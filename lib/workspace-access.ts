import type { Workspace, WorkspaceRole } from "@/app/generated/prisma/client";
import { getCurrentUserId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { getActiveWorkspace } from "@/lib/active-workspace";
import { ensureWorkspaceForUser } from "@/lib/workspace";

export type WorkspaceContext = {
  userId: string;
  workspaceId: string;
  workspace: Workspace;
  role: WorkspaceRole;
};

const ROLE_ORDER: Record<WorkspaceRole, number> = {
  MEMBER: 1,
  EDITOR: 2,
  ADMIN: 3,
  OWNER: 4,
};

export function hasWorkspaceRole(
  role: WorkspaceRole,
  minimumRole: WorkspaceRole
) {
  return ROLE_ORDER[role] >= ROLE_ORDER[minimumRole];
}

export function canManageWorkspace(role: WorkspaceRole) {
  return hasWorkspaceRole(role, "ADMIN");
}

export function canManageCampaigns(role: WorkspaceRole) {
  return hasWorkspaceRole(role, "EDITOR");
}

export function canManageBilling(role: WorkspaceRole) {
  return role === "OWNER";
}

/**
 * Diagnostics include process-wide queue and worker state. They are not a
 * workspace-scoped resource, so only the tenant owner may view them.
 */
export function canViewGlobalDiagnostics(role: WorkspaceRole) {
  return role === "OWNER";
}

export async function getCurrentWorkspaceContext(): Promise<WorkspaceContext | null> {
  const userId = await getCurrentUserId();
  if (!userId) return null;

  const active = await getActiveWorkspace(userId);

  if (active) {
    return {
      userId,
      workspaceId: active.workspace.id,
      workspace: active.workspace,
      role: active.role,
    };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  await ensureWorkspaceForUser(userId, user?.email);
  const reconciled = await getActiveWorkspace(userId);
  if (!reconciled) return null;

  return {
    userId,
    workspaceId: reconciled.workspace.id,
    workspace: reconciled.workspace,
    role: reconciled.role,
  };
}
