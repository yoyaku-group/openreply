import { headers } from "next/headers";
import { redirect } from "next/navigation";
import DashboardShell from "@/components/dashboard-shell";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import {
  ensureWorkspaceForUser,
  getHostWorkspaceTarget,
  listWorkspaceMemberships,
} from "@/lib/workspace";
import { getActiveWorkspace } from "@/lib/active-workspace";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/login");
  }

  await ensureWorkspaceForUser(session.user.id, session.user.email);
  const active = await getActiveWorkspace(session.user.id);
  if (!active) redirect("/login?error=AccessDenied");
  const workspace = active.workspace;
  const host = (await headers()).get("host");
  const pinnedHost = Boolean(getHostWorkspaceTarget(host));
  const workspaces = await listWorkspaceMemberships(
    session.user.id,
    pinnedHost ? workspace.id : null
  );
  const accounts = await prisma.instagramAccount.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { connectedAt: "desc" },
    select: { username: true },
  });

  return (
    <DashboardShell
      workspaceName={workspace.name}
      instagramUsername={accounts[0]?.username ?? null}
      instagramAccountCount={accounts.length}
      workspaces={workspaces}
      activeWorkspaceId={workspace.id}
    >
      {children}
    </DashboardShell>
  );
}
