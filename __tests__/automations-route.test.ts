import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockPrisma,
  mockGetMediaById,
  mockDecryptToken,
  mockAssertCommentCapability,
  mockAssertMessageCapability,
} = vi.hoisted(() => ({
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
  mockAssertCommentCapability: vi.fn(),
  mockAssertMessageCapability: vi.fn(),
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
vi.mock("@/lib/meta/capabilities", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/meta/capabilities")>();
  return {
    ...actual,
    assertInstagramCommentCapability: mockAssertCommentCapability,
    assertInstagramMessageCapability: mockAssertMessageCapability,
  };
});

import { PATCH, POST } from "@/app/api/automations/route";
import { InstagramCapabilityBlockedError } from "@/lib/meta/capabilities";

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
    id: "account_1",
    username: "minibarmusic",
    workspaceId: "workspace_1",
    accessToken: "encrypted_token",
    archivedAt: null,
  },
  trackedLinks: [
    { destinationUrl: "https://yoyaku.io/release/abc001/" },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ATTACH_NEXT_REEL_ENABLED", "true");
  mockPrisma.workspace.findUnique.mockResolvedValue({ id: "workspace_1" });
  mockPrisma.instagramAccount.findFirst.mockResolvedValue({
    id: "account_1",
    workspaceId: "workspace_1",
    username: "minibarmusic",
    accessToken: "encrypted_token",
    archivedAt: null,
  });
  mockPrisma.automation.findMany.mockResolvedValue([]);
  mockPrisma.automation.findFirst.mockResolvedValue(null);
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
  mockAssertCommentCapability.mockResolvedValue(undefined);
  mockAssertMessageCapability.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
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

  it("stores no catalogue reference on an inbound campaign", async () => {
    const response = await POST(
      request({
        name: "MB059 DM keyword",
        instagramAccountId: "account_1",
        triggerType: "INBOUND_DM",
        keywords: ["MB059"],
        // A comment-scope reference on an inbound trigger is meaningless; the
        // stored row must not carry it.
        pendingNextReel: true,
        catnoTag: "MB059",
        trackedDestinationUrl: "https://yoyaku.io/release/mb059/",
        dmMessage: "MB059 is available to pre-order.",
        isActive: false,
      }) as never
    );

    expect(response.status).toBe(201);
    expect(mockPrisma.automation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          triggerType: "INBOUND_DM",
          catnoTag: null,
          pendingNextReel: false,
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

  it("refuses to re-arm a catalogue campaign that already bound", async () => {
    mockPrisma.automation.findFirst.mockResolvedValueOnce({
      ...existingCommentCampaign,
      catnoTag: "TO001",
      pendingNextReel: false,
      isActive: false,
    });

    const response = await PATCH(
      patchRequest("automation_existing", {
        pendingNextReel: true,
        postId: null,
      }) as never
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.code).toBe("CATALOGUE_REARM_BLOCKED");
    expect(mockPrisma.automation.update).not.toHaveBeenCalled();
  });
});

const cataloguePayload = (overrides: Record<string, unknown> = {}) => ({
  name: "ABC001 release",
  instagramAccountId: "account_1",
  triggerType: "COMMENT",
  pendingNextReel: true,
  postId: null,
  catnoTag: "#ABC001",
  keywords: ["LINK"],
  dmMessage: "Here is the link.",
  trackedDestinationUrl: "https://yoyaku.io/release/abc001/",
  isActive: false,
  ...overrides,
});

const waitingCatalogue = (overrides: Record<string, unknown> = {}) => ({
  ...existingCommentCampaign,
  postId: null,
  postUrl: null,
  pendingNextReel: true,
  catnoTag: "ABC001",
  isActive: false,
  ...overrides,
});

const attachedCatalogue = (overrides: Record<string, unknown> = {}) => ({
  ...existingCommentCampaign,
  pendingNextReel: false,
  catnoTag: "ABC001",
  isActive: true,
  ...overrides,
});

const calendarCampaign = (overrides: Record<string, unknown> = {}) => ({
  ...existingCommentCampaign,
  source: "CALENDAR",
  lifecycle: "READY",
  pendingNextReel: false,
  catnoTag: "ABC001",
  isActive: true,
  ...overrides,
});

describe("POST /api/automations catalogue scope", () => {
  it("round-trips a canonical catalogue tag and its destination link", async () => {
    const response = await POST(
      request(cataloguePayload({ catnoTag: "  #abc001  " })) as never
    );
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(payload.data.catnoTag).toBe("ABC001");
    expect(mockPrisma.automation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          catnoTag: "ABC001",
          pendingNextReel: true,
          postId: null,
          isActive: false,
        }),
      })
    );
    const createArgs = mockPrisma.automation.create.mock.calls[0][0];
    expect(createArgs.data.trackedLinks.create).toEqual([
      expect.objectContaining({
        destinationUrl: "https://yoyaku.io/release/abc001/",
      }),
    ]);
  });

  it("rejects invalid internal punctuation instead of silently removing it", async () => {
    const response = await POST(
      request(cataloguePayload({ catnoTag: "ABC-001" })) as never
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.details.fieldErrors.catnoTag).toBeDefined();
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });

  it("requires a destination link even for a catalogue draft", async () => {
    const response = await POST(
      request(cataloguePayload({ trackedDestinationUrl: "" })) as never
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.details.fieldErrors.trackedDestinationUrl).toBeDefined();
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });

  it("allows different catalogue references to wait together", async () => {
    const first = await POST(request(cataloguePayload()) as never);
    const second = await POST(
      request(cataloguePayload({ name: "ABC002 release", catnoTag: "ABC002" })) as never
    );

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(mockPrisma.automation.create).toHaveBeenCalledTimes(2);
  });

  it("rejects a normalized duplicate including when both are drafts", async () => {
    mockPrisma.automation.findFirst.mockResolvedValueOnce({
      id: "draft_abc001",
      name: "ABC001 draft",
      source: "MANUAL",
      lifecycle: "ACTIVE",
      isActive: false,
    });

    const response = await POST(
      request(cataloguePayload({ catnoTag: "#abc001" })) as never
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.code).toBe("CATALOGUE_REF_CONFLICT");
    expect(payload.conflict).toMatchObject({ id: "draft_abc001" });
    expect(payload.conflictUrl).toBe("/campaigns/draft_abc001");
    expect(mockPrisma.automation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          instagramAccountId: "account_1",
          pendingNextReel: true,
          lifecycle: { not: "ARCHIVED" },
          OR: [
            { catnoTag: { equals: "ABC001", mode: "insensitive" } },
            { catnoTag: { equals: "#ABC001", mode: "insensitive" } },
          ],
        }),
      })
    );
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });

  it("rejects a Calendar campaign that is still unbound for the same reference", async () => {
    mockPrisma.automation.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "calendar_abc001",
        name: "Calendar ABC001",
        source: "CALENDAR",
        lifecycle: "READY",
        isActive: false,
      });

    const response = await POST(request(cataloguePayload()) as never);
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.code).toBe("CALENDAR_CAMPAIGN_CONFLICT");
    expect(payload.conflict.id).toBe("calendar_abc001");
    expect(payload.conflictUrl).toBe("/campaigns/calendar_abc001");
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });

  it("allows a draft but refuses to arm while the attach binder is disabled", async () => {
    vi.stubEnv("ATTACH_NEXT_REEL_ENABLED", "false");

    const draft = await POST(request(cataloguePayload()) as never);
    expect(draft.status).toBe(201);

    const armed = await POST(
      request(cataloguePayload({ isActive: true, name: "Armed ABC001" })) as never
    );
    const payload = await armed.json();

    expect(armed.status).toBe(409);
    expect(payload.code).toBe("CATALOGUE_BINDING_DISABLED");
  });

  it("refuses to arm when Instagram comment capability is blocked", async () => {
    mockAssertCommentCapability.mockRejectedValue(
      new InstagramCapabilityBlockedError(
        "account_1",
        "minibarmusic",
        "COMMENTS",
        ["missing instagram_business_manage_comments"]
      )
    );

    const response = await POST(
      request(cataloguePayload({ isActive: true })) as never
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.code).toBe("INSTAGRAM_CAPABILITY_BLOCKED");
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/automations catalogue scope", () => {
  it("adds a catalogue tag and requires its destination link", async () => {
    mockPrisma.automation.findFirst.mockResolvedValueOnce({
      ...existingCommentCampaign,
      postId: null,
      postUrl: null,
      pendingNextReel: true,
      catnoTag: null,
      isActive: false,
      trackedLinks: [],
    });

    const response = await PATCH(
      patchRequest("automation_existing", {
        catnoTag: "#abc001",
        pendingNextReel: true,
        postId: null,
        trackedDestinationUrl: "https://yoyaku.io/release/abc001/",
      }) as never
    );

    expect(response.status).toBe(200);
    expect(mockPrisma.automation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          catnoTag: "ABC001",
          pendingNextReel: true,
          postId: null,
        }),
      })
    );
  });

  it("clears the tag when switching away from a waiting catalogue target", async () => {
    mockPrisma.automation.findFirst.mockResolvedValueOnce(waitingCatalogue());

    const response = await PATCH(
      patchRequest("automation_existing", {
        catnoTag: null,
        pendingNextReel: false,
        postId: "media_1",
      }) as never
    );

    expect(response.status).toBe(200);
    expect(mockPrisma.automation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          catnoTag: null,
          pendingNextReel: false,
          postId: "media_1",
        }),
      })
    );
  });

  it("clears the tag when switching to generic next-post mode", async () => {
    mockPrisma.automation.findFirst.mockResolvedValueOnce(waitingCatalogue());

    const response = await PATCH(
      patchRequest("automation_existing", {
        catnoTag: null,
        pendingNextReel: true,
        postId: null,
      }) as never
    );

    expect(response.status).toBe(200);
    expect(mockPrisma.automation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          catnoTag: null,
          pendingNextReel: true,
        }),
      })
    );
    const genericConflictCheck = mockPrisma.automation.findFirst.mock.calls.find(
      ([args]) => args.where?.pendingNextReel === true && args.where?.catnoTag === null
    );
    expect(genericConflictCheck).toBeDefined();
  });

  it("preserves the tag on an ordinary edit and excludes self from conflicts", async () => {
    mockPrisma.automation.findFirst.mockResolvedValueOnce(waitingCatalogue());

    const response = await PATCH(
      patchRequest("automation_existing", { dmMessage: "Updated copy" }) as never
    );

    expect(response.status).toBe(200);
    expect(mockPrisma.automation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          dmMessage: "Updated copy",
          catnoTag: "ABC001",
        }),
      })
    );
    const selfExcluding = mockPrisma.automation.findFirst.mock.calls.find(
      ([args]) => args.where?.id?.not === "automation_existing"
    );
    expect(selfExcluding).toBeDefined();
    expect(selfExcluding?.[0].where).toMatchObject({
      instagramAccountId: "account_1",
      pendingNextReel: true,
      lifecycle: { not: "ARCHIVED" },
    });
  });

  it("keeps a bound catalogue campaign's tag on ordinary edits", async () => {
    mockPrisma.automation.findFirst.mockResolvedValueOnce(attachedCatalogue());

    const response = await PATCH(
      patchRequest("automation_existing", { dmMessage: "Updated copy" }) as never
    );

    expect(response.status).toBe(200);
    expect(mockPrisma.automation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ catnoTag: "ABC001" }),
      })
    );
    const updateArgs = mockPrisma.automation.update.mock.calls[0][0];
    expect(updateArgs.data.pendingNextReel).not.toBe(true);
  });

  it("refuses to re-arm a bound catalogue campaign", async () => {
    mockPrisma.automation.findFirst.mockResolvedValueOnce(attachedCatalogue());

    const response = await PATCH(
      patchRequest("automation_existing", {
        pendingNextReel: true,
        postId: null,
      }) as never
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.code).toBe("CATALOGUE_REARM_BLOCKED");
  });

  it("refuses to change the reference of a bound catalogue campaign", async () => {
    mockPrisma.automation.findFirst.mockResolvedValueOnce(attachedCatalogue());

    const response = await PATCH(
      patchRequest("automation_existing", { catnoTag: "ABC002" }) as never
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.code).toBe("CATALOGUE_TAG_IMMUTABLE");
  });

  it("keeps Calendar's publication binding immutable", async () => {
    for (const change of [
      { triggerType: "INBOUND_DM" },
      { postId: "media_2" },
      { catnoTag: "ABC002" },
      { keywords: ["BUY"] },
      { trackedDestinationUrl: "https://example.com/other" },
    ]) {
      mockPrisma.automation.findFirst.mockResolvedValueOnce(calendarCampaign());
      const response = await PATCH(
        patchRequest("automation_existing", change) as never
      );
      const payload = await response.json();
      expect(response.status, JSON.stringify(change)).toBe(409);
      expect(payload.code).toBe("CALENDAR_BINDING_IMMUTABLE");
    }
    expect(mockPrisma.automation.update).not.toHaveBeenCalled();
  });

  it("refuses to activate a Calendar campaign where a manual campaign is already bound", async () => {
    mockPrisma.automation.findFirst
      .mockResolvedValueOnce(calendarCampaign({ isActive: false, lifecycle: "READY" }))
      .mockResolvedValueOnce({
        id: "manual_abc001",
        name: "Manual ABC001",
        source: "MANUAL",
        lifecycle: "ACTIVE",
        isActive: true,
      });

    const response = await PATCH(
      patchRequest("automation_existing", { isActive: true }) as never
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.code).toBe("CALENDAR_CAMPAIGN_CONFLICT");
    expect(payload.conflict.id).toBe("manual_abc001");
    expect(payload.conflictUrl).toBe("/campaigns/manual_abc001");
    expect(mockPrisma.automation.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          instagramAccountId: "account_1",
          postId: "media_1",
          isActive: true,
          lifecycle: { not: "ARCHIVED" },
          id: { not: "automation_existing" },
          OR: [
            { catnoTag: { equals: "ABC001", mode: "insensitive" } },
            { catnoTag: { equals: "#ABC001", mode: "insensitive" } },
          ],
        }),
      })
    );
    expect(mockPrisma.automation.update).not.toHaveBeenCalled();
  });

  it("still allows pausing a Calendar campaign", async () => {
    mockPrisma.automation.findFirst.mockResolvedValueOnce(calendarCampaign());

    const response = await PATCH(
      patchRequest("automation_existing", { isActive: false }) as never
    );

    expect(response.status).toBe(200);
    expect(mockPrisma.automation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isActive: false, catnoTag: "ABC001" }),
      })
    );
  });

  it("allows a draft edit while the binder is disabled", async () => {
    vi.stubEnv("ATTACH_NEXT_REEL_ENABLED", "false");
    mockPrisma.automation.findFirst.mockResolvedValueOnce(waitingCatalogue());

    const response = await PATCH(
      patchRequest("automation_existing", { dmMessage: "Updated copy" }) as never
    );

    expect(response.status).toBe(200);
  });

  it("still allows pausing when capability checks fail", async () => {
    mockAssertCommentCapability.mockRejectedValue(
      new InstagramCapabilityBlockedError(
        "account_1",
        "minibarmusic",
        "COMMENTS",
        ["missing permission"]
      )
    );
    mockPrisma.automation.findFirst.mockResolvedValueOnce(
      waitingCatalogue({ isActive: true })
    );

    const response = await PATCH(
      patchRequest("automation_existing", { isActive: false }) as never
    );

    expect(response.status).toBe(200);
    expect(mockAssertCommentCapability).not.toHaveBeenCalled();
  });

  it("refuses to arm a draft while the binder is disabled", async () => {
    vi.stubEnv("ATTACH_NEXT_REEL_ENABLED", "false");
    mockPrisma.automation.findFirst.mockResolvedValueOnce(waitingCatalogue());

    const response = await PATCH(
      patchRequest("automation_existing", { isActive: true }) as never
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.code).toBe("CATALOGUE_BINDING_DISABLED");
  });

  it("refuses to arm a draft when capability checks fail", async () => {
    mockAssertCommentCapability.mockRejectedValue(
      new InstagramCapabilityBlockedError(
        "account_1",
        "minibarmusic",
        "COMMENTS",
        ["missing permission"]
      )
    );
    mockPrisma.automation.findFirst.mockResolvedValueOnce(waitingCatalogue());

    const response = await PATCH(
      patchRequest("automation_existing", { isActive: true }) as never
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.code).toBe("INSTAGRAM_CAPABILITY_BLOCKED");
  });
});
