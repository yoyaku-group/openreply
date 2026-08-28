import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    workspaceMember: { findFirst: vi.fn(), findMany: vi.fn() },
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import { listWorkspaceMemberships, resolveActiveWorkspace } from "../lib/workspace";

const OLDEST = {
  workspace: { id: "ws_yoyaku", name: "YOYAKU" },
  role: "OWNER",
};
const OBJECTS = {
  workspace: { id: "ws_objects", name: "Objects Presswerk" },
  role: "OWNER",
};

describe("resolveActiveWorkspace", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns the cookie-selected workspace when the user is a member", async () => {
    mockPrisma.workspaceMember.findFirst.mockResolvedValue(OBJECTS);

    const active = await resolveActiveWorkspace("user_b", "ws_objects");

    expect(active).toEqual({
      workspace: { id: "ws_objects", name: "Objects Presswerk" },
      role: "OWNER",
    });
    expect(mockPrisma.workspaceMember.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user_b", workspaceId: "ws_objects" },
      })
    );
  });

  it("falls back to the oldest membership when the cookie points elsewhere", async () => {
    mockPrisma.workspaceMember.findFirst.mockImplementation(
      async ({ where }: { where?: { workspaceId?: string } }) =>
        where?.workspaceId ? null : OLDEST
    );

    const active = await resolveActiveWorkspace("user_b", "ws_foreign");

    expect(active?.workspace.id).toBe("ws_yoyaku");
  });

  it("uses the oldest membership when no cookie is set", async () => {
    mockPrisma.workspaceMember.findFirst.mockResolvedValue(OLDEST);

    const active = await resolveActiveWorkspace("user_anna", null);

    expect(active?.workspace.id).toBe("ws_yoyaku");
    expect(mockPrisma.workspaceMember.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user_anna" },
      })
    );
  });

  it("fails closed instead of falling back when the host requires a workspace", async () => {
    mockPrisma.workspaceMember.findFirst.mockResolvedValue(null);
    const active = await resolveActiveWorkspace("user_objects", "ws_objects", true);
    expect(active).toBeNull();
    expect(mockPrisma.workspaceMember.findFirst).toHaveBeenCalledTimes(1);
  });
});

describe("listWorkspaceMemberships", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns the workspace list, oldest first", async () => {
    mockPrisma.workspaceMember.findMany.mockResolvedValue([
      { workspace: { id: "ws_yoyaku", name: "YOYAKU" } },
      { workspace: { id: "ws_objects", name: "Objects Presswerk" } },
    ]);

    const workspaces = await listWorkspaceMemberships("user_b");

    expect(workspaces).toEqual([
      { id: "ws_yoyaku", name: "YOYAKU" },
      { id: "ws_objects", name: "Objects Presswerk" },
    ]);
    expect(mockPrisma.workspaceMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user_b" },
        orderBy: { createdAt: "asc" },
      })
    );
  });

  it("can restrict the switcher to a host-pinned workspace", async () => {
    mockPrisma.workspaceMember.findMany.mockResolvedValue([
      { workspace: { id: "ws_objects", name: "Objects Presswerk" } },
    ]);
    await listWorkspaceMemberships("user_b", "ws_objects");
    expect(mockPrisma.workspaceMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user_b", workspaceId: "ws_objects" } })
    );
  });
});
