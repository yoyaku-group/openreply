import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockContext } = vi.hoisted(() => ({
  mockPrisma: {
    instagramAccount: { deleteMany: vi.fn() },
  },
  mockContext: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/workspace-access", () => ({
  canManageWorkspace: vi.fn((role: string) => role === "OWNER" || role === "ADMIN"),
  getCurrentWorkspaceContext: mockContext,
}));

import { POST } from "../app/api/instagram/disconnect/route";

const requestWith = (body: unknown) =>
  ({ json: async () => body }) as unknown as Parameters<typeof POST>[0];

const OWNER = { userId: "user_b", workspaceId: "ws_y", workspace: { id: "ws_y" }, role: "OWNER" };

describe("disconnect guard (incident 2026-08-27: empty body wiped a whole workspace)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockPrisma.instagramAccount.deleteMany.mockResolvedValue({ count: 0 });
  });

  it("rejects an empty body with 400 and deletes nothing", async () => {
    mockContext.mockResolvedValue(OWNER);

    const response = await POST(requestWith({}));

    expect(response.status).toBe(400);
    expect(mockPrisma.instagramAccount.deleteMany).not.toHaveBeenCalled();
  });

  it("rejects a non-string instagramAccountId with 400", async () => {
    mockContext.mockResolvedValue(OWNER);

    const response = await POST(requestWith({ instagramAccountId: 42 }));

    expect(response.status).toBe(400);
    expect(mockPrisma.instagramAccount.deleteMany).not.toHaveBeenCalled();
  });

  it("disconnects exactly one account when the id is provided", async () => {
    mockContext.mockResolvedValue(OWNER);

    const response = await POST(requestWith({ instagramAccountId: "ig_1" }));

    expect(response.status).toBe(200);
    expect(mockPrisma.instagramAccount.deleteMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws_y", id: "ig_1" },
    });
  });

  it("stays admin-gated", async () => {
    mockContext.mockResolvedValue({ ...OWNER, role: "MEMBER" });

    const response = await POST(requestWith({ instagramAccountId: "ig_1" }));

    expect(response.status).toBe(403);
    expect(mockPrisma.instagramAccount.deleteMany).not.toHaveBeenCalled();
  });

  it("rejects anonymous calls", async () => {
    mockContext.mockResolvedValue(null);

    const response = await POST(requestWith({ instagramAccountId: "ig_1" }));

    expect(response.status).toBe(401);
  });
});
