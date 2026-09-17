import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockPrisma, mockGetMediaById, mockDecryptToken } = vi.hoisted(() => ({
  mockPrisma: {
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
    workspace: { findUnique: vi.fn() },
    instagramAccount: { findFirst: vi.fn() },
    automation: {
      findMany: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    trackedLink: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
  mockGetMediaById: vi.fn(),
  mockDecryptToken: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({ getCurrentWorkspaceId: vi.fn() }));
vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: vi.fn(async () => ({
    workspaceId: "workspace_1",
    role: "OWNER",
  })),
  canManageCampaigns: vi.fn(() => true),
}));
vi.mock("@/lib/meta/client", () => ({ getMediaById: mockGetMediaById }));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: mockDecryptToken }));

import { PATCH, POST } from "@/app/api/automations/route";

function request(body: Record<string, unknown>) {
  return new Request("http://localhost/api/automations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patchRequest(id: string, body: Record<string, unknown>) {
  return new NextRequest(`http://localhost/api/automations?id=${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const commentCampaign = {
  name: "Comment campaign",
  instagramAccountId: "account_1",
  postId: "media_1",
  keywords: ["LINK"],
  dmMessage: "Here is the link.",
  isActive: false,
};

const existingCommentCampaign = {
  id: "automation_existing",
  workspaceId: "workspace_1",
  instagramAccountId: "account_1",
  triggerType: "COMMENT",
  postId: "media_1",
  postUrl: "https://instagram.com/p/example/",
  pendingNextReel: false,
  matchAnyPost: false,
  keywords: ["LINK"],
  matchAnyWord: false,
  dmMessage: "Here is the link.",
  openingDmEnabled: false,
  openingDmMessage: null,
  openingDmButtonLabel: null,
  isActive: true,
  instagramAccount: {
    username: "minibarmusic",
    accessToken: "encrypted_token",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.workspace.findUnique.mockResolvedValue({ id: "workspace_1" });
  mockPrisma.instagramAccount.findFirst.mockResolvedValue({
    id: "account_1",
    workspaceId: "workspace_1",
    username: "minibarmusic",
    accessToken: "encrypted_token",
  });
  mockPrisma.automation.findMany.mockResolvedValue([]);
  mockPrisma.automation.create.mockImplementation(async ({ data }) => ({
    id: "automation_new",
    ...data,
    trackedLinks: [],
  }));
  mockPrisma.automation.update.mockImplementation(async ({ data }) => ({
    ...existingCommentCampaign,
    ...data,
  }));
  mockPrisma.$executeRaw.mockResolvedValue(0);
  mockPrisma.$transaction.mockImplementation(
    async (callback: (tx: typeof mockPrisma) => Promise<unknown>) =>
      callback(mockPrisma)
  );
  mockDecryptToken.mockReturnValue("decrypted_token");
  mockGetMediaById.mockResolvedValue({ id: "media_1" });
});

describe("POST /api/automations trigger modes", () => {
  it("keeps omitted triggerType backward-compatible with comments", async () => {
    const response = await POST(request(commentCampaign) as never);
    expect(response.status).toBe(201);
    expect(mockPrisma.automation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ triggerType: "COMMENT" }),
      })
    );
  });

  it("creates a paused inbound campaign and clears comment-only fields", async () => {
    const response = await POST(
      request({
        name: "MB059 DM keyword",
        instagramAccountId: "account_1",
        triggerType: "INBOUND_DM",
        keywords: ["MB059"],
        dmMessage: "MB059 is available to pre-order.",
        openingDmEnabled: true,
        openingDmMessage: "Opening",
        openingDmButtonLabel: "Continue",
        publicReplyEnabled: true,
        publicReplyMessages: ["Sent"],
        requireFollow: true,
        followUpEnabled: true,
        isActive: false,
      }) as never
    );

    expect(response.status).toBe(201);
    expect(mockPrisma.automation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          triggerType: "INBOUND_DM",
          postId: null,
          matchAnyPost: false,
          pendingNextReel: false,
          matchAnyWord: false,
          openingDmEnabled: false,
          publicReplyEnabled: false,
          requireFollow: false,
          followUpEnabled: false,
          isActive: false,
        }),
      })
    );
  });

  it("rejects sentences and any-word matching for inbound campaigns", async () => {
    const response = await POST(
      request({
        name: "Unsafe inbound",
        instagramAccountId: "account_1",
        triggerType: "INBOUND_DM",
        keywords: ["send MB059"],
        matchAnyWord: true,
        dmMessage: "Link",
        isActive: false,
      }) as never
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.details.fieldErrors.keywords).toBeDefined();
    expect(payload.details.fieldErrors.matchAnyWord).toBeDefined();
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });

  it("returns 409 when an active inbound keyword overlaps", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      { id: "existing", name: "Existing", keywords: ["#mb059."] },
    ]);

    const response = await POST(
      request({
        name: "MB059 DM keyword",
        instagramAccountId: "account_1",
        triggerType: "INBOUND_DM",
        keywords: ["MB059"],
        dmMessage: "Link",
        isActive: true,
      }) as never
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.code).toBe("INBOUND_KEYWORD_CONFLICT");
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });

  it("refuses activation when the selected account cannot read the post", async () => {
    mockGetMediaById.mockRejectedValue(new Error("Unsupported get request"));

    const response = await POST(
      request({ ...commentCampaign, isActive: true }) as never
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.code).toBe("POST_NOT_ACCESSIBLE");
    expect(payload.error).toContain("@minibarmusic");
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });
});

describe("POST /api/automations pending-next guard", () => {
  const pendingNextCampaign = {
    name: "Next post campaign",
    instagramAccountId: "account_1",
    pendingNextReel: true,
    keywords: ["LINK"],
    dmMessage: "Here is the link.",
    isActive: false,
  };

  it("creates the campaign when no other campaign waits for the next post", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(null);

    const response = await POST(request(pendingNextCampaign) as never);

    expect(response.status).toBe(201);
    expect(mockPrisma.$executeRaw).toHaveBeenCalled();
    expect(mockPrisma.automation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ pendingNextReel: true, postId: null }),
      })
    );
  });

  it("returns 409 when another campaign already waits for the next post", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue({
      id: "other",
      name: "Elina instore",
    });

    const response = await POST(request(pendingNextCampaign) as never);
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.code).toBe("PENDING_NEXT_CONFLICT");
    expect(payload.error).toContain("Elina instore");
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/automations trigger safety", () => {
  it("does not re-check Meta for an unrelated edit to an active campaign", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(existingCommentCampaign);

    const response = await PATCH(
      patchRequest("automation_existing", { dmMessage: "Updated copy" }) as never
    );

    expect(response.status).toBe(200);
    expect(mockGetMediaById).not.toHaveBeenCalled();
    expect(mockPrisma.automation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ dmMessage: "Updated copy" }),
      })
    );
  });

  it("re-checks Meta when a paused specific-post campaign is activated", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...existingCommentCampaign,
      isActive: false,
    });
    mockGetMediaById.mockRejectedValue(new Error("Unsupported get request"));

    const response = await PATCH(
      patchRequest("automation_existing", { isActive: true }) as never
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.code).toBe("POST_NOT_ACCESSIBLE");
    expect(mockPrisma.automation.update).not.toHaveBeenCalled();
  });

  it("clears comment-only state when switching to inbound DM", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...existingCommentCampaign,
      isActive: false,
      keywords: [],
      matchAnyWord: true,
      openingDmEnabled: true,
      openingDmMessage: "Opening",
      openingDmButtonLabel: "Continue",
    });

    const response = await PATCH(
      patchRequest("automation_existing", {
        triggerType: "INBOUND_DM",
        keywords: ["MB059"],
      }) as never
    );

    expect(response.status).toBe(200);
    expect(mockPrisma.automation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          triggerType: "INBOUND_DM",
          matchAnyWord: false,
          postId: null,
          pendingNextReel: false,
          openingDmEnabled: false,
        }),
      })
    );
  });

  it("serializes active inbound keyword writes and returns conflicts", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...existingCommentCampaign,
      triggerType: "INBOUND_DM",
      postId: null,
      postUrl: null,
      keywords: ["MB059"],
      isActive: false,
    });
    mockPrisma.automation.findMany.mockResolvedValue([
      { id: "other", name: "Other", keywords: ["#mb059."] },
    ]);

    const response = await PATCH(
      patchRequest("automation_existing", { isActive: true }) as never
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.code).toBe("INBOUND_KEYWORD_CONFLICT");
    expect(mockPrisma.$executeRaw).toHaveBeenCalled();
    expect(mockPrisma.automation.update).not.toHaveBeenCalled();
  });

  it("arms the next post or reel when no other campaign waits", async () => {
    mockPrisma.automation.findFirst
      .mockResolvedValueOnce(existingCommentCampaign)
      .mockResolvedValueOnce(null);

    const response = await PATCH(
      patchRequest("automation_existing", {
        pendingNextReel: true,
        postId: null,
      }) as never
    );

    expect(response.status).toBe(200);
    expect(mockPrisma.automation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ pendingNextReel: true }),
      })
    );
  });

  it("returns 409 when another campaign already waits for the next post", async () => {
    mockPrisma.automation.findFirst
      .mockResolvedValueOnce(existingCommentCampaign)
      .mockResolvedValueOnce({ id: "other", name: "Elina instore" });

    const response = await PATCH(
      patchRequest("automation_existing", {
        pendingNextReel: true,
        postId: null,
      }) as never
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.code).toBe("PENDING_NEXT_CONFLICT");
    expect(mockPrisma.automation.update).not.toHaveBeenCalled();
  });

  it("keeps catalogue-tagged campaigns exempt from the one-pending rule", async () => {
    mockPrisma.automation.findFirst.mockResolvedValueOnce({
      ...existingCommentCampaign,
      catnoTag: "TO001",
      isActive: false,
    });

    const response = await PATCH(
      patchRequest("automation_existing", {
        pendingNextReel: true,
        postId: null,
      }) as never
    );

    expect(response.status).toBe(200);
    expect(mockPrisma.automation.update).toHaveBeenCalled();
  });
});
