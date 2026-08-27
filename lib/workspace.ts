import { prisma } from "@/lib/db/client";
import type { Workspace, WorkspaceRole } from "@/app/generated/prisma/client";

/** Cookie holding the workspace a multi-membership user switched to. */
export const ACTIVE_WORKSPACE_COOKIE = "or_ws";

function normalizeInviteEmail(email: string) {
  return email.trim().toLowerCase();
}

export async function acceptPendingInvitationsForUser(
  userId: string,
  email?: string | null
): Promise<void> {
  if (!email) return;

  const normalizedEmail = normalizeInviteEmail(email);
  const now = new Date();
  const invitations = await prisma.workspaceInvitation.findMany({
    where: {
      email: normalizedEmail,
      status: "PENDING",
      expiresAt: { gt: now },
    },
  });

  for (const invitation of invitations) {
    await prisma.$transaction([
      prisma.workspaceMember.upsert({
        where: {
          workspaceId_userId: {
            workspaceId: invitation.workspaceId,
            userId,
          },
        },
        create: {
          workspaceId: invitation.workspaceId,
          userId,
          role: invitation.role,
        },
        update: {
          role: invitation.role,
        },
      }),
      prisma.workspaceInvitation.update({
        where: { id: invitation.id },
        data: {
          status: "ACCEPTED",
          acceptedAt: now,
        },
      }),
    ]);
  }
}

export async function getWorkspaceMembership(userId: string): Promise<{
  workspace: Workspace;
  role: WorkspaceRole;
} | null> {
  const membership = await prisma.workspaceMember.findFirst({
    where: { userId },
    include: { workspace: true },
    orderBy: { createdAt: "asc" },
  });

  if (!membership) return null;

  return {
    workspace: membership.workspace,
    role: membership.role,
  };
}

/**
 * Parses AUTH_DOMAIN_WORKSPACES ("objects.press=Objects Presswerk") and
 * returns the mapped workspace name for an email domain, or null.
 */
export function getDomainWorkspaceName(
  email?: string | null
): string | null {
  const raw = process.env.AUTH_DOMAIN_WORKSPACES;
  if (!raw || !email) return null;
  const domain = email.split("@")[1]?.trim().toLowerCase();
  if (!domain) return null;

  for (const pair of raw.split(",")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const mappedDomain = pair.slice(0, separator).trim().toLowerCase();
    const mappedName = pair.slice(separator + 1).trim();
    if (mappedDomain === domain && mappedName) return mappedName;
  }
  return null;
}

/**
 * Single-organization mode for self-hosted instances: instead of provisioning
 * every new user their own empty OWNER workspace (upstream default, sensible
 * for a SaaS), a colleague passing the domain allowlist joins the oldest
 * existing workspace as MEMBER and immediately sees the connected Instagram
 * accounts. Explicit invitations keep priority and their role. The very first
 * user still creates the workspace and owns it.
 *
 * Domain routing: an email domain mapped in AUTH_DOMAIN_WORKSPACES joins that
 * named workspace instead of the oldest one, so a second organization can
 * share the instance without seeing the first one's Instagram accounts,
 * campaigns, or DMs. A mapped workspace that does not exist yet falls back to
 * the oldest-workspace default.
 */
async function joinExistingWorkspaceIfConfigured(
  userId: string,
  email?: string | null
): Promise<Workspace | null> {
  if (process.env.AUTH_JOIN_EXISTING_WORKSPACE !== "true") return null;

  const routedName = getDomainWorkspaceName(email);
  if (routedName) {
    const routed = await prisma.workspace.findFirst({
      where: { name: routedName },
    });
    if (routed) {
      await prisma.workspaceMember.upsert({
        where: { workspaceId_userId: { workspaceId: routed.id, userId } },
        create: { workspaceId: routed.id, userId, role: "MEMBER" },
        update: {},
      });
      return routed;
    }
  }

  const oldest = await prisma.workspace.findFirst({
    orderBy: { createdAt: "asc" },
  });
  if (!oldest) return null;

  await prisma.workspaceMember.upsert({
    where: { workspaceId_userId: { workspaceId: oldest.id, userId } },
    create: { workspaceId: oldest.id, userId, role: "MEMBER" },
    update: {},
  });

  return oldest;
}

export async function ensureWorkspaceForUser(
  userId: string,
  email?: string | null
): Promise<Workspace> {
  await acceptPendingInvitationsForUser(userId, email);

  const existingMembership = await getWorkspaceMembership(userId);
  if (existingMembership) {
    return existingMembership.workspace;
  }

  const joined = await joinExistingWorkspaceIfConfigured(userId, email);
  if (joined) return joined;

  const workspaceName = email ? `${email.split("@")[0]}'s workspace` : "My workspace";

  return prisma.workspace.create({
    data: {
      name: workspaceName,
      ownerId: userId,
      members: {
        create: {
          userId,
          role: "OWNER",
        },
      },
    },
  });
}

export async function getPrimaryWorkspace(userId: string): Promise<Workspace | null> {
  const membership = await getWorkspaceMembership(userId);
  return membership?.workspace ?? null;
}

/**
 * Resolves the workspace a request should act on: the cookie-selected
 * workspace when the user is a member of it, otherwise the oldest
 * membership. Stale or foreign cookie values silently fall back.
 */
export async function resolveActiveWorkspace(
  userId: string,
  preferredWorkspaceId?: string | null
): Promise<{ workspace: Workspace; role: WorkspaceRole } | null> {
  if (preferredWorkspaceId) {
    const preferred = await prisma.workspaceMember.findFirst({
      where: { userId, workspaceId: preferredWorkspaceId },
      include: { workspace: true },
    });
    if (preferred) {
      return { workspace: preferred.workspace, role: preferred.role };
    }
  }
  return getWorkspaceMembership(userId);
}

/**
 * All workspaces the user belongs to, oldest first. Drives the switcher UI.
 */
export async function listWorkspaceMemberships(
  userId: string
): Promise<{ id: string; name: string }[]> {
  const memberships = await prisma.workspaceMember.findMany({
    where: { userId },
    include: { workspace: { select: { id: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
  return memberships.map((membership) => membership.workspace);
}
