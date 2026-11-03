import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { context, media } = vi.hoisted(() => ({
  context: { workspaceId: "", role: "OWNER" },
  media: { value: {} as Record<string, unknown> },
}));
vi.mock("@/lib/auth", () => ({ getCurrentWorkspaceId: vi.fn(() => context.workspaceId) }));
vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: vi.fn(async () => context),
  canManageCampaigns: vi.fn(() => true),
}));
vi.mock("@/lib/meta/capabilities", () => ({
  InstagramCapabilityBlockedError: class extends Error {},
  assertInstagramCommentCapability: vi.fn(),
  assertInstagramMessageCapability: vi.fn(),
  campaignRequiresMessageCapability: vi.fn(() => false),
}));
vi.mock("@/lib/meta/client", () => ({
  getMediaById: vi.fn(async () => media.value),
  getUserMedia: vi.fn(async () => [media.value]),
}));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: vi.fn(() => "never-used-fixture") }));

import { prisma } from "@/lib/db/client";
import { POST, PATCH } from "@/app/api/automations/route";
import { bindPendingAutomationsForMedia } from "@/lib/release-sync/attach-pending-automations";

const databaseUrl = process.env.OPENREPLY_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
suite("catalogue API with real PostgreSQL transactions", () => {
  let accountId: string;
  let instagramId: string;
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (url.hostname !== "127.0.0.1" || !url.pathname.includes("test")) {
      throw new Error("Explicit isolated loopback test database required");
    }
    vi.stubEnv("DATABASE_URL", databaseUrl!);
    vi.stubEnv("ATTACH_NEXT_REEL_ENABLED", "true");
    const owner = await prisma.user.create({ data: {} });
    const workspace = await prisma.workspace.create({
      data: { name: "Catalogue concurrency fixture", ownerId: owner.id },
    });
    context.workspaceId = workspace.id;
  });
  beforeEach(async () => {
    instagramId = randomUUID();
    accountId = (await prisma.instagramAccount.create({ data: {
      workspaceId: context.workspaceId, instagramId,
      username: "catalogue_test", accessToken: "never-used-fixture",
    } })).id;
  });
  afterAll(async () => { await prisma.$disconnect(); vi.unstubAllEnvs(); });

  function create(catnoTag: string, isActive = false) {
    return POST(new NextRequest("http://localhost/api/automations", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: `Fixture ${catnoTag}`, instagramAccountId: accountId,
        triggerType: "COMMENT", pendingNextReel: true, catnoTag,
        keywords: ["LINK"], dmMessage: "Here is your record.",
        trackedDestinationUrl: "https://example.com/record", isActive,
      }),
    }));
  }

  it("accepts two distinct references concurrently on the same account", async () => {
    const tag = `REF${randomUUID().replaceAll("-", "")}`;
    const replies = await Promise.all([create(`${tag}A`), create(`${tag}B`)]);
    expect(replies.map(r => r.status)).toEqual([201, 201]);
  });

  it("accepts exactly one normalized duplicate during simultaneous creations", async () => {
    const tag = `REF${randomUUID().replaceAll("-", "")}`.toUpperCase();
    const replies = await Promise.all([create(` #${tag.toLowerCase()} `), create(tag)]);
    expect(replies.map(r => r.status).sort()).toEqual([201, 409]);
    const conflict = replies.find(r => r.status === 409)!;
    expect((await conflict.json()).code).toBe("CATALOGUE_REF_CONFLICT");
    const rows = await prisma.automation.findMany({
      where: { instagramAccountId: accountId, catnoTag: tag },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ isActive: false, pendingNextReel: true });
  });

  it("rejects a PATCH collision using the new effective reference", async () => {
    const tag = `REF${randomUUID().replaceAll("-", "")}`;
    expect((await create(`${tag}A`)).status).toBe(201);
    expect((await create(`${tag}B`)).status).toBe(201);
    const row = await prisma.automation.findFirstOrThrow({
      where: { instagramAccountId: accountId, catnoTag: `${tag}B`.toUpperCase() },
    });
    const response = await PATCH(new NextRequest(`http://localhost/api/automations?id=${row.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ catnoTag: `${tag}A` }),
    }));
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("CATALOGUE_REF_CONFLICT");
    expect((await prisma.automation.findUniqueOrThrow({ where: { id: row.id } })).catnoTag)
      .toBe(`${tag}B`.toUpperCase());
  });

  it("does not attach a manual campaign when Calendar has already claimed the same post", async () => {
    const tag = `REF${randomUUID().replaceAll("-", "")}`.toUpperCase();
    const mediaId = `media-${randomUUID()}`;
    const common = {
      workspaceId: context.workspaceId, instagramAccountId: accountId,
      catnoTag: tag, keywords: ["LINK"], dmMessage: "Fixture message",
    };
    const manual = await prisma.automation.create({ data: {
      ...common, name: "Manual fixture", isActive: true, pendingNextReel: true,
      createdAt: new Date(Date.now() - 10_000),
    } });
    await prisma.automation.create({ data: {
      ...common, name: "Calendar fixture", source: "CALENDAR", lifecycle: "READY",
      postId: mediaId, pendingNextReel: false, isActive: false,
    } });
    media.value = {
      id: mediaId, caption: `Record #${tag}`, timestamp: new Date().toISOString(),
      media_type: "IMAGE", media_product_type: "FEED",
      permalink: "https://www.instagram.com/p/fixture/",
    };
    const bound = await bindPendingAutomationsForMedia({ instagramAccountId: instagramId, mediaId });
    expect(bound).toBe(0);
    expect(await prisma.automation.findUniqueOrThrow({ where: { id: manual.id } }))
      .toMatchObject({ postId: null, isActive: false, lifecycle: "NEEDS_ATTENTION" });
  });
});
