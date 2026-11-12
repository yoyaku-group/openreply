import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    workspaceMember: { findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
// The real role helpers, minus the session plumbing this unit does not use.
vi.mock("@/lib/workspace-access", () => ({
  canManageCampaigns: (role: string) =>
    ["EDITOR", "ADMIN", "OWNER"].includes(role),
}));

import { canReadLab, canWriteLab, labWriterAllowlist } from "@/lib/copywriter/lab-access";
import type { WorkspaceContext } from "@/lib/workspace-access";

function context(overrides: Partial<WorkspaceContext> = {}): WorkspaceContext {
  return {
    userId: "user_1",
    workspaceId: "workspace_1",
    workspace: { id: "workspace_1", name: "W" } as WorkspaceContext["workspace"],
    role: "OWNER",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mockPrisma.workspaceMember.findFirst.mockResolvedValue({ id: "member_owner" });
  mockPrisma.user.findUnique.mockResolvedValue({ email: "ben@yoyaku.fr" });
});

describe("canWriteLab", () => {
  it("lets an OWNER write straight from the role", async () => {
    expect(await canWriteLab(context({ role: "OWNER" }))).toBe(true);
    expect(mockPrisma.workspaceMember.findFirst).not.toHaveBeenCalled();
  });

  it("refuses an editor when the workspace has an owner", async () => {
    expect(await canWriteLab(context({ role: "EDITOR" }))).toBe(false);
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("falls back to the allowlist only when NO owner member exists", async () => {
    mockPrisma.workspaceMember.findFirst.mockResolvedValue(null);
    vi.stubEnv("COPYWRITER_LAB_EMAILS", "ben@yoyaku.fr,shop@yoyaku.fr");
    expect(await canWriteLab(context({ role: "EDITOR" }))).toBe(true);
    mockPrisma.user.findUnique.mockResolvedValue({ email: "other@yoyaku.fr" });
    expect(await canWriteLab(context({ role: "MEMBER" }))).toBe(false);
  });

  it("the allowlist never grants a MEMBER write access", async () => {
    mockPrisma.workspaceMember.findFirst.mockResolvedValue(null);
    vi.stubEnv("COPYWRITER_LAB_EMAILS", "ben@yoyaku.fr");
    mockPrisma.user.findUnique.mockResolvedValue({ email: "ben@yoyaku.fr" });
    expect(await canWriteLab(context({ role: "MEMBER" }))).toBe(false);
    expect(await canWriteLab(context({ role: "EDITOR" }))).toBe(true);
  });

  it("fails closed when no owner exists and the allowlist is empty or unset", async () => {
    mockPrisma.workspaceMember.findFirst.mockResolvedValue(null);
    delete process.env.COPYWRITER_LAB_EMAILS;
    expect(await canWriteLab(context({ role: "EDITOR" }))).toBe(false);
    vi.stubEnv("COPYWRITER_LAB_EMAILS", "   ");
    expect(await canWriteLab(context({ role: "ADMIN" }))).toBe(false);
  });

  it("matches allowlist emails case-insensitively and ignores blanks", () => {
    vi.stubEnv("COPYWRITER_LAB_EMAILS", " Ben@YoYaku.fr , ,shop@yoyaku.fr");
    expect(labWriterAllowlist()).toEqual(["ben@yoyaku.fr", "shop@yoyaku.fr"]);
    expect(labWriterAllowlist("")).toEqual([]);
  });
});

describe("canReadLab", () => {
  it("editors and above may read; members may not", () => {
    expect(canReadLab("OWNER")).toBe(true);
    expect(canReadLab("ADMIN")).toBe(true);
    expect(canReadLab("EDITOR")).toBe(true);
    expect(canReadLab("MEMBER")).toBe(false);
  });
});
