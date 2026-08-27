import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import DashboardShell from "@/components/dashboard-shell";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import {
  ACTIVE_WORKSPACE_COOKIE,
  ensureWorkspaceForUser,
  listWorkspaceMemberships,
  resolveActiveWorkspace,
} from "@/lib/workspace";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/login");
  }

  const store = await cookies();
  const preferredWorkspaceId = store.get(ACTIVE_WORKSPACE_COOKIE)?.value;
  const active = await resolveActiveWorkspace(
    session.user.id,
    preferredWorkspaceId
  );
  const workspace =
    active?.workspace ??
    (await ensureWorkspaceForUser(session.user.id, session.user.email));
  const workspaces = await listWorkspaceMemberships(session.user.id);
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
