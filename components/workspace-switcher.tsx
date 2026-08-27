"use client";

/**
 * Workspace switcher for users belonging to more than one workspace
 * (e.g. an owner overseeing two organizations on a shared instance).
 * Persists the choice via the /api/workspace/switch cookie.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";

interface WorkspaceOption {
  id: string;
  name: string;
}

export default function WorkspaceSwitcher({
  workspaces,
  activeWorkspaceId,
}: {
  workspaces: WorkspaceOption[];
  activeWorkspaceId: string;
}) {
  const router = useRouter();
  const [switching, setSwitching] = useState(false);

  async function handleSwitch(workspaceId: string) {
    if (workspaceId === activeWorkspaceId) return;
    setSwitching(true);
    try {
      const response = await fetch("/api/workspace/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      if (!response.ok) throw new Error(`switch failed: ${response.status}`);
      router.refresh();
    } catch (error) {
      console.error(error);
    } finally {
      setSwitching(false);
    }
  }

  return (
    <select
      aria-label="Active workspace"
      disabled={switching}
      value={activeWorkspaceId}
      onChange={(event) => handleSwitch(event.target.value)}
      className="w-full mt-1 rounded border border-border bg-surface px-2 py-1 text-xs text-foreground disabled:opacity-50"
    >
      {workspaces.map((workspace) => (
        <option key={workspace.id} value={workspace.id}>
          {workspace.name}
        </option>
      ))}
    </select>
  );
}
