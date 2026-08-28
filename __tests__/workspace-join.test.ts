import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    workspaceInvitation: { findMany: vi.fn() },
    workspaceMember: { findFirst: vi.fn(), upsert: vi.fn() },
    workspace: { findFirst: vi.fn(), create: vi.fn() },
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import {
  DomainWorkspaceNotFoundError,
  ensureWorkspaceForUser,
  getDomainWorkspaceTarget,
} from "../lib/workspace";

const OLDEST = { id: "ws_oldest", name: "b's workspace", ownerId: "user_b" };

describe("single-organization workspace join", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockPrisma.workspaceInvitation.findMany.mockResolvedValue([]);
    mockPrisma.workspaceMember.findFirst.mockResolvedValue(null);
    mockPrisma.workspaceMember.upsert.mockResolvedValue({});
    mockPrisma.workspace.create.mockImplementation(
      async ({ data }: { data: { name: string } }) => ({
        id: "ws_new",
        name: data.name,
      })
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("joins the oldest workspace as MEMBER when the mode is enabled", async () => {
    vi.stubEnv("AUTH_JOIN_EXISTING_WORKSPACE", "true");
    mockPrisma.workspace.findFirst.mockResolvedValue(OLDEST);

    const workspace = await ensureWorkspaceForUser("user_anna", "anna@yoyaku.fr");

    expect(workspace.id).toBe("ws_oldest");
    expect(mockPrisma.workspaceMember.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ role: "MEMBER", userId: "user_anna" }),
      })
    );
    expect(mockPrisma.workspace.create).not.toHaveBeenCalled();
  });

  it("still creates an OWNER workspace for the very first user", async () => {
    vi.stubEnv("AUTH_JOIN_EXISTING_WORKSPACE", "true");
    mockPrisma.workspace.findFirst.mockResolvedValue(null);

    const workspace = await ensureWorkspaceForUser("user_first", "b@yoyaku.fr");

    expect(workspace.id).toBe("ws_new");
    expect(mockPrisma.workspace.create).toHaveBeenCalled();
  });

  it("keeps the upstream own-workspace behavior when the mode is off", async () => {
    vi.stubEnv("AUTH_JOIN_EXISTING_WORKSPACE", "false");

    const workspace = await ensureWorkspaceForUser("user_solo", "solo@yoyaku.fr");

    expect(workspace.id).toBe("ws_new");
    expect(mockPrisma.workspace.findFirst).not.toHaveBeenCalled();
  });

  it("prefers an existing membership over joining", async () => {
    vi.stubEnv("AUTH_JOIN_EXISTING_WORKSPACE", "true");
    mockPrisma.workspaceMember.findFirst.mockResolvedValue({
      workspace: { id: "ws_mine" },
      role: "ADMIN",
    });

    const workspace = await ensureWorkspaceForUser("user_known", "known@yoyaku.fr");

    expect(workspace.id).toBe("ws_mine");
    expect(mockPrisma.workspaceMember.upsert).not.toHaveBeenCalled();
  });
});

describe("domain-routed workspace join", () => {
  const OBJECTS = { id: "ws_objects", name: "Objects Presswerk" };

  beforeEach(() => {
    vi.resetAllMocks();
    mockPrisma.workspaceInvitation.findMany.mockResolvedValue([]);
    mockPrisma.workspaceMember.findFirst.mockResolvedValue(null);
    mockPrisma.workspaceMember.upsert.mockResolvedValue({});
    vi.stubEnv("AUTH_JOIN_EXISTING_WORKSPACE", "true");
    vi.stubEnv("AUTH_DOMAIN_WORKSPACES", "objects.press=id:ws_objects");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("routes a mapped email domain to the named workspace", async () => {
    mockPrisma.workspace.findFirst.mockImplementation(
      async ({ where }: { where?: { id?: string } }) =>
        where?.id === OBJECTS.id ? OBJECTS : OLDEST
    );

    const workspace = await ensureWorkspaceForUser(
      "user_ravi",
      "ravi@objects.press"
    );

    expect(workspace.id).toBe("ws_objects");
    expect(mockPrisma.workspaceMember.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          workspaceId: "ws_objects",
          userId: "user_ravi",
          role: "EDITOR",
        }),
      })
    );
  });

  it("fails closed when the mapped workspace is missing", async () => {
    mockPrisma.workspace.findFirst.mockResolvedValue(null);

    await expect(
      ensureWorkspaceForUser("user_ravi", "ravi@objects.press")
    ).rejects.toBeInstanceOf(DomainWorkspaceNotFoundError);
    expect(mockPrisma.workspaceMember.upsert).not.toHaveBeenCalled();
  });

  it("keeps the oldest-workspace default for unmapped domains", async () => {
    mockPrisma.workspace.findFirst.mockResolvedValue(OLDEST);

    const workspace = await ensureWorkspaceForUser(
      "user_anna",
      "anna@yoyaku.fr"
    );

    expect(workspace.id).toBe("ws_oldest");
  });

  it("parses AUTH_DOMAIN_WORKSPACES case-insensitively and skips bad pairs", () => {
    vi.stubEnv(
      "AUTH_DOMAIN_WORKSPACES",
      " Objects.Press = id:ws_objects , malformed ,a.com=Alpha"
    );

    expect(getDomainWorkspaceTarget("ravi@objects.press")).toBe("id:ws_objects");
    expect(getDomainWorkspaceTarget("x@a.com")).toBe("Alpha");
    expect(getDomainWorkspaceTarget("anna@yoyaku.fr")).toBeNull();
    expect(getDomainWorkspaceTarget(null)).toBeNull();
  });

  it("returns no mapping when the env is absent", () => {
    vi.stubEnv("AUTH_DOMAIN_WORKSPACES", "");

    expect(getDomainWorkspaceTarget("ravi@objects.press")).toBeNull();
  });
});
