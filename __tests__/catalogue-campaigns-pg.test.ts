import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";

const databaseUrl = process.env.OPENREPLY_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const { state } = vi.hoisted(() => ({ state: { workspaceId: "" } }));

vi.mock("@/lib/auth", () => ({
  getCurrentWorkspaceId: vi.fn(async () => state.workspaceId),
}));

vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: vi.fn(async () => ({
    workspaceId: state.workspaceId,
    role: "OWNER",
  })),
  canManageCampaigns: vi.fn(() => true),
}));

import { prisma } from "@/lib/db/client";
import { POST } from "@/app/api/automations/route";

suite("catalogue campaign PostgreSQL serialization", () => {
  let ownerId = "";
  let workspaceId = "";
  let accountId = "";

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (
      !["127.0.0.1", "localhost"].includes(url.hostname) ||
      !url.pathname.includes("test")
    ) {
      throw new Error("isolated local test database required");
    }
    vi.stubEnv("DATABASE_URL", databaseUrl!);
    const owner = await prisma.user.create({ data: {} });
    ownerId = owner.id;
    const workspace = await prisma.workspace.create({
      data: { name: "Catalogue concurrency fixture", ownerId },
    });
    workspaceId = workspace.id;
    state.workspaceId = workspaceId;
    const account = await prisma.instagramAccount.create({
      data: {
        workspaceId,
        instagramId: randomUUID(),
        username: "catalogueconcurrency",
        accessToken: "never-used-fixture",
      },
    });
    accountId = account.id;
  });

  afterAll(async () => {
    if (accountId) {
      await prisma.automation.deleteMany({ where: { instagramAccountId: accountId } });
      await prisma.instagramAccount.delete({ where: { id: accountId } });
    }
    if (workspaceId) {
      await prisma.workspace.delete({ where: { id: workspaceId } });
    }
    if (ownerId) await prisma.user.delete({ where: { id: ownerId } });
    await prisma.$disconnect();
    vi.unstubAllEnvs();
  });

  function createRequest(catnoTag: string) {
    return new NextRequest("http://localhost/api/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: `Catalogue ${catnoTag}`,
        instagramAccountId: accountId,
        triggerType: "COMMENT",
        pendingNextReel: true,
        postId: null,
        catnoTag,
        keywords: ["LINK"],
        dmMessage: "Here is the link.",
        trackedDestinationUrl: "https://yoyaku.io/release/abc001/",
        isActive: false,
      }),
    });
  }

  it("creates exactly one draft for the same normalized reference under concurrency", async () => {
    const responses = await Promise.all([
      POST(createRequest("#abc001")),
      POST(createRequest("ABC001")),
    ]);
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([201, 409]);

    const rows = await prisma.automation.findMany({
      where: {
        instagramAccountId: accountId,
        catnoTag: "ABC001",
        pendingNextReel: true,
      },
    });
    expect(rows).toHaveLength(1);
  });
});
