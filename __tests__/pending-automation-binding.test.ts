import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InstagramMedia } from "@/lib/meta/client";

const { mockPrisma, mockGetMediaById, mockGetUserMedia, mockDecryptToken } =
  vi.hoisted(() => ({
    mockPrisma: {
      automation: {
        findMany: vi.fn(),
        findFirst: vi.fn(),
        updateMany: vi.fn(),
      },
    },
    mockGetMediaById: vi.fn(),
    mockGetUserMedia: vi.fn(),
    mockDecryptToken: vi.fn(),
  }));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/meta/client", () => ({
  getMediaById: mockGetMediaById,
  getUserMedia: mockGetUserMedia,
}));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: mockDecryptToken }));

import {
  attachPendingNextReels,
  bindPendingAutomationsForMedia,
  resetMediaMemo,
  selectBindingsForMedia,
} from "@/lib/release-sync/attach-pending-automations";

const CREATED_AT = new Date("2026-09-17T14:00:00Z");

function media(overrides: Partial<InstagramMedia> = {}): InstagramMedia {
  return {
    id: "media_1",
    media_type: "IMAGE",
    media_product_type: "FEED",
    timestamp: "2026-09-17T15:00:00+0000",
    permalink: "https://www.instagram.com/p/abcdef/",
    ...overrides,
  };
}

function pendingAutomation(overrides: Record<string, unknown> = {}) {
  return {
    id: "automation_1",
    name: "Campaign",
    createdAt: CREATED_AT,
    catnoTag: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMediaMemo();
  process.env.ATTACH_NEXT_REEL_ENABLED = "true";
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockDecryptToken.mockReturnValue("decrypted_token");
  mockPrisma.automation.findFirst.mockResolvedValue(null);
  mockPrisma.automation.updateMany.mockResolvedValue({ count: 1 });
});

describe("selectBindingsForMedia", () => {
  it("binds a feed image published after the campaign was created", () => {
    const bindings = selectBindingsForMedia(
      [pendingAutomation()],
      media({ media_type: "IMAGE", media_product_type: "FEED" }),
    );
    expect(bindings).toEqual([
      {
        automationId: "automation_1",
        mediaId: "media_1",
        postUrl: "https://www.instagram.com/p/abcdef/",
      },
    ]);
  });

  it("binds a carousel published after the campaign was created", () => {
    const bindings = selectBindingsForMedia(
      [pendingAutomation()],
      media({ media_type: "CAROUSEL_ALBUM", media_product_type: "FEED" }),
    );
    expect(bindings).toHaveLength(1);
  });

  it("binds a feed video published after the campaign was created", () => {
    const bindings = selectBindingsForMedia(
      [pendingAutomation()],
      media({ media_type: "VIDEO", media_product_type: "FEED" }),
    );
    expect(bindings).toHaveLength(1);
  });

  it("binds a reel published after the campaign was created", () => {
    const bindings = selectBindingsForMedia(
      [pendingAutomation()],
      media({ media_type: "VIDEO", media_product_type: "REELS" }),
    );
    expect(bindings).toHaveLength(1);
  });

  it("never binds stories or other non-feed surfaces", () => {
    const bindings = selectBindingsForMedia(
      [pendingAutomation()],
      media({ media_type: "VIDEO", media_product_type: "STORIES" }),
    );
    expect(bindings).toHaveLength(0);
  });

  it("never binds a post published before the campaign was created", () => {
    const bindings = selectBindingsForMedia(
      [pendingAutomation()],
      media({ timestamp: "2026-09-17T13:59:00+0000" }),
    );
    expect(bindings).toHaveLength(0);
  });

  it("fails closed for a catalogue-tagged campaign whose caption has no match", () => {
    const bindings = selectBindingsForMedia(
      [pendingAutomation({ catnoTag: "TO001" })],
      media({ caption: "Instore announcement" }),
    );
    expect(bindings).toHaveLength(0);
  });

  it("binds a catalogue-tagged campaign to its exact caption match", () => {
    const bindings = selectBindingsForMedia(
      [pendingAutomation({ catnoTag: "TO001" })],
      media({ caption: "New release #TO001 out now" }),
    );
    expect(bindings).toHaveLength(1);
  });

  it("evaluates every pending campaign independently", () => {
    const bindings = selectBindingsForMedia(
      [
        pendingAutomation({ id: "before", createdAt: new Date("2026-09-17T16:00:00Z") }),
        pendingAutomation({ id: "after" }),
      ],
      media(),
    );
    expect(bindings.map((binding) => binding.automationId)).toEqual(["after"]);
  });
});

describe("bindPendingAutomationsForMedia (just-in-time)", () => {
  it("does nothing when the account has no pending campaign", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);

    const bound = await bindPendingAutomationsForMedia({
      instagramAccountId: "ig_account",
      mediaId: "media_1",
    });

    expect(bound).toBe(0);
    expect(mockGetMediaById).not.toHaveBeenCalled();
  });

  it("binds a pending campaign to the media a comment arrived on", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...pendingAutomation(),
        instagramAccountId: "account_1",
        instagramAccount: { accessToken: "encrypted" },
      },
    ]);
    mockGetMediaById.mockResolvedValue(media());

    const bound = await bindPendingAutomationsForMedia({
      instagramAccountId: "ig_account",
      mediaId: "media_1",
    });

    expect(bound).toBe(1);
    expect(mockPrisma.automation.updateMany).toHaveBeenCalledWith({
      where: { id: "automation_1", pendingNextReel: true },
      data: {
        postId: "media_1",
        postUrl: "https://www.instagram.com/p/abcdef/",
        pendingNextReel: false,
      },
    });
  });

  it("does not count a campaign another driver already bound", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...pendingAutomation(),
        instagramAccountId: "account_1",
        instagramAccount: { accessToken: "encrypted" },
      },
    ]);
    mockGetMediaById.mockResolvedValue(media());
    mockPrisma.automation.updateMany.mockResolvedValue({ count: 0 });

    const bound = await bindPendingAutomationsForMedia({
      instagramAccountId: "ig_account",
      mediaId: "media_1",
    });

    expect(bound).toBe(0);
  });

  it("stays silent when the media cannot be fetched", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...pendingAutomation(),
        instagramAccountId: "account_1",
        instagramAccount: { accessToken: "encrypted" },
      },
    ]);
    mockGetMediaById.mockRejectedValue(new Error("Unsupported get request"));

    const bound = await bindPendingAutomationsForMedia({
      instagramAccountId: "ig_account",
      mediaId: "media_1",
    });

    expect(bound).toBe(0);
    expect(mockPrisma.automation.updateMany).not.toHaveBeenCalled();
  });

  it("binds a catalogue campaign to the matching media a comment arrived on", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...pendingAutomation({ catnoTag: "ABC001" }),
        instagramAccountId: "account_1",
        instagramAccount: { accessToken: "encrypted" },
      },
    ]);
    mockGetMediaById.mockResolvedValue(
      media({ caption: "Out now #abc001", media_product_type: "FEED" })
    );

    const bound = await bindPendingAutomationsForMedia({
      instagramAccountId: "ig_account",
      mediaId: "media_1",
    });

    expect(bound).toBe(1);
    expect(mockPrisma.automation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "automation_1", pendingNextReel: true },
        data: expect.objectContaining({ postId: "media_1" }),
      })
    );
  });

  it("parks a catalogue campaign when Calendar gained the same reference later", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...pendingAutomation({ catnoTag: "ABC001" }),
        instagramAccountId: "account_1",
        instagramAccount: { accessToken: "encrypted" },
      },
    ]);
    mockPrisma.automation.findFirst.mockResolvedValue({
      id: "calendar_1",
      name: "Calendar ABC001",
      source: "CALENDAR",
      lifecycle: "READY",
      isActive: false,
    });
    mockGetMediaById.mockResolvedValue(media({ caption: "#ABC001 out now" }));

    const bound = await bindPendingAutomationsForMedia({
      instagramAccountId: "ig_account",
      mediaId: "media_1",
    });

    expect(bound).toBe(0);
    expect(mockPrisma.automation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          source: "CALENDAR",
          pendingNextReel: false,
          id: { not: "automation_1" },
        }),
      })
    );
    expect(mockPrisma.automation.updateMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.automation.updateMany).toHaveBeenCalledWith({
      where: {
        id: "automation_1",
        pendingNextReel: true,
        lifecycle: { not: "NEEDS_ATTENTION" },
      },
      data: { isActive: false, lifecycle: "NEEDS_ATTENTION" },
    });
  });

  it("does nothing when the binder is disabled", async () => {
    process.env.ATTACH_NEXT_REEL_ENABLED = "false";

    const bound = await bindPendingAutomationsForMedia({
      instagramAccountId: "ig_account",
      mediaId: "media_1",
    });

    expect(bound).toBe(0);
    expect(mockPrisma.automation.findMany).not.toHaveBeenCalled();
  });

  it("fetches the media once per pending set and again when the set changes", async () => {
    const pendingRow = (id: string, catnoTag: string) => ({
      ...pendingAutomation({ id, catnoTag }),
      instagramAccountId: "account_1",
      instagramAccount: { accessToken: "encrypted" },
    });
    mockGetMediaById.mockResolvedValue(
      media({ caption: "#ABC001 out now #ABC002 too" })
    );

    mockPrisma.automation.findMany.mockResolvedValue([
      pendingRow("automation_abc001", "ABC001"),
    ]);
    await bindPendingAutomationsForMedia({
      instagramAccountId: "ig_account",
      mediaId: "media_1",
    });
    await bindPendingAutomationsForMedia({
      instagramAccountId: "ig_account",
      mediaId: "media_1",
    });

    expect(mockGetMediaById).toHaveBeenCalledTimes(1);

    // Arming a second campaign changes the pending set, so the fetch happens
    // again at once rather than waiting for the memo to expire.
    mockPrisma.automation.findMany.mockResolvedValue([
      pendingRow("automation_abc001", "ABC001"),
      pendingRow("automation_abc002", "ABC002"),
    ]);
    await bindPendingAutomationsForMedia({
      instagramAccountId: "ig_account",
      mediaId: "media_1",
    });

    expect(mockGetMediaById).toHaveBeenCalledTimes(2);
  });

  it("retries a media fetch that failed", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...pendingAutomation(),
        instagramAccountId: "account_1",
        instagramAccount: { accessToken: "encrypted" },
      },
    ]);
    mockGetMediaById.mockRejectedValueOnce(new Error("rate limited"));
    mockGetMediaById.mockResolvedValue(media());

    await bindPendingAutomationsForMedia({
      instagramAccountId: "ig_account",
      mediaId: "media_1",
    });
    const bound = await bindPendingAutomationsForMedia({
      instagramAccountId: "ig_account",
      mediaId: "media_1",
    });

    expect(mockGetMediaById).toHaveBeenCalledTimes(2);
    expect(bound).toBe(1);
  });
});

describe("attachPendingNextReels (sweep)", () => {
  it("reports disabled without touching the database", async () => {
    process.env.ATTACH_NEXT_REEL_ENABLED = "false";

    const summary = await attachPendingNextReels();

    expect(summary).toEqual({
      enabled: false,
      pending: 0,
      accounts: 0,
      checked: 0,
      bound: 0,
      conflicts: 0,
      failedAccounts: 0,
    });
    expect(mockPrisma.automation.findMany).not.toHaveBeenCalled();
  });

  it("binds eligible campaigns and reports account-level failures", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...pendingAutomation(),
        instagramAccountId: "account_1",
        instagramAccount: { id: "account_1", accessToken: "encrypted_1" },
      },
      {
        ...pendingAutomation({ id: "automation_2" }),
        instagramAccountId: "account_2",
        instagramAccount: { id: "account_2", accessToken: "encrypted_2" },
      },
    ]);
    mockDecryptToken.mockImplementation((value: string) => `token:${value}`);
    mockGetUserMedia.mockImplementation(async (token: string) => {
      if (token === "token:encrypted_1") return [media()];
      throw new Error("rate limited");
    });

    const summary = await attachPendingNextReels();

    expect(summary).toMatchObject({
      enabled: true,
      pending: 2,
      accounts: 2,
      checked: 2,
      bound: 1,
      failedAccounts: 1,
    });
  });

  it("ignores a media that is not eligible yet", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...pendingAutomation(),
        instagramAccountId: "account_1",
        instagramAccount: { id: "account_1", accessToken: "encrypted_1" },
      },
    ]);
    mockGetUserMedia.mockResolvedValue([
      media({ timestamp: "2026-09-17T13:00:00+0000" }),
    ]);

    const summary = await attachPendingNextReels();

    expect(summary.bound).toBe(0);
    expect(mockPrisma.automation.updateMany).not.toHaveBeenCalled();
  });

  it("binds three catalogue references to their own earliest matching publication", async () => {
    mockPrisma.automation.findMany.mockResolvedValue(
      ["TO001", "TO002", "TO003"].map((tag) => ({
        ...pendingAutomation({ id: `automation_${tag}`, catnoTag: tag }),
        instagramAccountId: "account_1",
        instagramAccount: { id: "account_1", accessToken: "encrypted" },
      }))
    );
    mockGetUserMedia.mockResolvedValue([
      // Old post before any campaign existed, and a story with a valid tag:
      // neither may satisfy the campaign.
      media({
        id: "to001_before",
        timestamp: "2026-09-17T13:00:00+0000",
        caption: "#TO001 old",
      }),
      media({
        id: "to001_story",
        timestamp: "2026-09-17T15:30:00+0000",
        media_product_type: "STORIES",
        caption: "#TO001 story",
      }),
      // Deliberately out of order.
      media({
        id: "to002_late",
        timestamp: "2026-09-18T10:00:00+0000",
        caption: "#TO002 late",
      }),
      media({
        id: "to001_first",
        timestamp: "2026-09-17T15:00:00+0000",
        caption: "Out now #to001",
      }),
      media({
        id: "to003_first",
        timestamp: "2026-09-17T17:00:00+0000",
        caption: "#TO003",
      }),
      media({
        id: "to002_first",
        timestamp: "2026-09-17T16:00:00+0000",
        caption: "#TO002",
      }),
      media({
        id: "wrong_tag",
        timestamp: "2026-09-17T15:10:00+0000",
        caption: "#TO9999",
      }),
    ]);

    const summary = await attachPendingNextReels();

    expect(summary).toMatchObject({ bound: 3, conflicts: 0 });
    const boundTo = new Map(
      mockPrisma.automation.updateMany.mock.calls.map(([args]) => [
        args.where.id,
        args.data.postId,
      ])
    );
    expect(Object.fromEntries(boundTo)).toEqual({
      automation_TO001: "to001_first",
      automation_TO002: "to002_first",
      automation_TO003: "to003_first",
    });
  });

  it("does not double-count a campaign bound by a concurrent driver", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...pendingAutomation(),
        instagramAccountId: "account_1",
        instagramAccount: { id: "account_1", accessToken: "encrypted_1" },
      },
    ]);
    mockGetUserMedia.mockResolvedValue([media()]);
    mockPrisma.automation.updateMany.mockResolvedValue({ count: 0 });

    const summary = await attachPendingNextReels();

    expect(summary.bound).toBe(0);
  });
});
