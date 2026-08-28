import { prisma } from "@/lib/db/client";
import type { Workspace, WorkspaceRole } from "@/app/generated/prisma/client";

/** Cookie holding the workspace a multi-membership user switched to. */
export const ACTIVE_WORKSPACE_COOKIE = "or_ws";

export class DomainWorkspaceNotFoundError extends Error {
  constructor(domain: string) {
    super(`Configured workspace for ${domain} was not found`);
    this.name = "DomainWorkspaceNotFoundError";
  }
}

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
 * returns the mapped workspace target for an email domain, or null. Targets
 * may be legacy names or stable `id:<workspaceId>` values.
 */
export function getDomainWorkspaceTarget(
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
    const mappedTarget = pair.slice(separator + 1).trim();
    if (mappedDomain === domain && mappedTarget) return mappedTarget;
  }
  return null;
}

/**
 * Parses AUTH_DOMAIN_ADMIN_WORKSPACES:
 * "yoyaku.fr=id:ws_y|id:ws_o,objects.press=id:ws_o".
 */
export function getDomainAdminWorkspaceTargets(email?: string | null): string[] {
  const raw = process.env.AUTH_DOMAIN_ADMIN_WORKSPACES;
  if (!raw || !email) return [];
  const domain = email.split("@")[1]?.trim().toLowerCase();
  if (!domain) return [];
  for (const pair of raw.split(",")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    if (pair.slice(0, separator).trim().toLowerCase() !== domain) continue;
    return pair
      .slice(separator + 1)
      .split("|")
      .map((target) => target.trim())
      .filter(Boolean);
  }
  return [];
}

export function getHostWorkspaceTarget(host?: string | null): string | null {
  const raw = process.env.OPENREPLY_HOST_WORKSPACES;
  const hostname = String(host || "").split(":")[0].trim().toLowerCase();
  if (!raw || !hostname) return null;
  for (const pair of raw.split(",")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    if (pair.slice(0, separator).trim().toLowerCase() === hostname) {
      return pair.slice(separator + 1).trim() || null;
    }
  }
  return null;
}

async function resolveWorkspaceTarget(target: string): Promise<Workspace | null> {
  return prisma.workspace.findFirst({
    where: target.startsWith("id:") ? { id: target.slice(3) } : { name: target },
  });
}

/** Applies the domain policy at sign-in and never downgrades an OWNER. */
export async function reconcileDomainAdminMemberships(
  userId: string,
  email?: string | null
): Promise<string[]> {
  const missingTargets: string[] = [];
  for (const target of getDomainAdminWorkspaceTargets(email)) {
    const workspace = await resolveWorkspaceTarget(target);
    if (!workspace) {
      missingTargets.push(target);
      console.error("[workspace-policy] configured ADMIN workspace was not found", {
        target,
        domain: email?.split("@")[1]?.toLowerCase() ?? "configured domain",
      });
      continue;
    }
    const existing = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId } },
    });
    if (existing?.role === "OWNER") continue;
    await prisma.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId } },
      create: { workspaceId: workspace.id, userId, role: "ADMIN" },
      update: { role: "ADMIN" },
    });
  }
  return missingTargets;
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
 * configured workspace instead of the oldest one, so a second organization can
 * share the instance without seeing the first one's Instagram accounts,
 * campaigns, or DMs. A mapped workspace that does not exist fails closed: a
 * configuration mistake must never grant the first tenant's data by default.
 */
async function joinExistingWorkspaceIfConfigured(
  userId: string,
  email?: string | null
): Promise<Workspace | null> {
  if (process.env.AUTH_JOIN_EXISTING_WORKSPACE !== "true") return null;

  const routedTarget = getDomainWorkspaceTarget(email);
  if (routedTarget) {
    const domain = email?.split("@")[1]?.trim().toLowerCase() ?? "configured domain";
    const routed = await prisma.workspace.findFirst({
      where: routedTarget.startsWith("id:")
        ? { id: routedTarget.slice(3) }
        : { name: routedTarget },
    });
    if (!routed) throw new DomainWorkspaceNotFoundError(domain);

    await prisma.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId: routed.id, userId } },
      create: { workspaceId: routed.id, userId, role: "EDITOR" },
      update: {},
    });
    return routed;
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
  await reconcileDomainAdminMemberships(userId, email);

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
  preferredWorkspaceId?: string | null,
  requiredWorkspace = false
): Promise<{ workspace: Workspace; role: WorkspaceRole } | null> {
  if (preferredWorkspaceId) {
    const preferred = await prisma.workspaceMember.findFirst({
      where: { userId, workspaceId: preferredWorkspaceId },
      include: { workspace: true },
    });
    if (preferred) {
      return { workspace: preferred.workspace, role: preferred.role };
    }
    if (requiredWorkspace) return null;
  }
  return getWorkspaceMembership(userId);
}

/**
 * All workspaces the user belongs to, oldest first. Drives the switcher UI.
 */
export async function listWorkspaceMemberships(
  userId: string,
  pinnedWorkspaceId?: string | null
): Promise<{ id: string; name: string }[]> {
  const memberships = await prisma.workspaceMember.findMany({
    where: { userId, ...(pinnedWorkspaceId ? { workspaceId: pinnedWorkspaceId } : {}) },
    include: { workspace: { select: { id: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
  return memberships.map((membership) => membership.workspace);
}

export async function resolveHostWorkspaceId(host?: string | null): Promise<string | null> {
  const target = getHostWorkspaceTarget(host);
  if (!target) return null;
  const workspace = await resolveWorkspaceTarget(target);
  if (!workspace) throw new DomainWorkspaceNotFoundError(String(host || "host"));
  return workspace.id;
}
