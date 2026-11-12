import type { WorkspaceRole } from "@/app/generated/prisma/client";
import { canManageCampaigns } from "@/lib/workspace-access";
import type { WorkspaceContext } from "@/lib/workspace-access";
import { prisma } from "@/lib/db/client";

/**
 * Prompt-lab authorization (lot S4).
 *
 * Writes are owner-only, through the existing workspace role helper
 * (`lib/workspace-access`). Deployments whose workspace carries no OWNER
 * member at all fall back to the `COPYWRITER_LAB_EMAILS` allowlist —
 * comma-separated emails, and FAIL-CLOSED when it is empty or unset.
 * Editors may read the lab but not write; members see 403 everywhere.
 */
export function canReadLab(role: WorkspaceRole): boolean {
  return canManageCampaigns(role);
}

/** Parsed, lower-cased allowlist; empty when the env is absent or blank. */
export function labWriterAllowlist(raw = process.env.COPYWRITER_LAB_EMAILS): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export async function canWriteLab(context: WorkspaceContext): Promise<boolean> {
  if (context.role === "OWNER") return true;
  // The allowlist fallback can never grant MORE than the role grants: a
  // member stays read-refused even when their email is allowlisted.
  if (!canReadLab(context.role)) return false;

  // Fallback path only when NO owner member exists on this workspace.
  const owner = await prisma.workspaceMember.findFirst({
    where: { workspaceId: context.workspaceId, role: "OWNER" },
    select: { id: true },
  });
  if (owner) return false;

  const allowlist = labWriterAllowlist();
  if (allowlist.length === 0) return false;
  const user = await prisma.user.findUnique({
    where: { id: context.userId },
    select: { email: true },
  });
  const email = user?.email?.trim().toLowerCase();
  return !!email && allowlist.includes(email);
}
