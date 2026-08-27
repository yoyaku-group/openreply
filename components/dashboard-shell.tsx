"use client";

import { useState } from "react";
import Sidebar from "@/components/sidebar";
import TopBar from "@/components/top-bar";

interface DashboardShellProps {
  children: React.ReactNode;
  workspaceName: string;
  instagramUsername: string | null;
  instagramAccountCount: number;
  workspaces?: { id: string; name: string }[];
  activeWorkspaceId?: string;
}

export default function DashboardShell({
  children,
  workspaceName,
  instagramUsername,
  instagramAccountCount,
  workspaces,
  activeWorkspaceId,
}: DashboardShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        workspaceName={workspaceName}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
      />

      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar
          onMenuClick={() => setSidebarOpen(true)}
          instagramUsername={instagramUsername}
          instagramAccountCount={instagramAccountCount}
        />

        <main className="flex-1 overflow-y-auto">
          <div className="px-4 lg:px-8 py-6 max-w-7xl mx-auto">{children}</div>
        </main>
      </div>
    </div>
  );
}
