import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getCurrentUserId: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: {} }));
vi.mock("@/lib/active-workspace", () => ({ getActiveWorkspace: vi.fn() }));
vi.mock("@/lib/workspace", () => ({ ensureWorkspaceForUser: vi.fn() }));

import {
  canManageCampaigns,
  canManageWorkspace,
} from "@/lib/workspace-access";

describe("workspace roles", () => {
  it("allows editors to manage campaigns but not workspace administration", () => {
    expect(canManageCampaigns("EDITOR")).toBe(true);
    expect(canManageWorkspace("EDITOR")).toBe(false);
  });
});
