import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    automation: { create: vi.fn() },
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import { createGeneratedCampaign } from "@/lib/automations/create-generated";
import type { CampaignCopy } from "@/lib/copy/yoyaku-patterns";

const copy: CampaignCopy = {
  name: "LM02 release",
  goal: "Announce the release",
  openingDmMessage: "Opening",
  openingDmButtonLabel: "Get the link",
  dmMessage: "Here is the release.",
  linkButtonLabel: "Open link",
  trackedDestinationUrl: "https://yoyaku.io/release/lm02/",
};

function input(catnoTag: string | null) {
  return {
    copy,
    catnoTag,
    workspaceId: "workspace_1",
    instagramAccountId: "account_1",
    isActive: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mockPrisma.automation.create.mockImplementation(async ({ data }) => ({
    id: "automation_new",
    ...data,
    trackedLinks: data.trackedLinks.create.map((link: object, i: number) => ({
      id: `link_${i}`,
      ...link,
    })),
  }));
});

describe("createGeneratedCampaign catalogue reference guard", () => {
  it.each(["---", "", "   "])(
    "returns null for a SKU that normalizes to nothing (%j) and creates nothing",
    async (sku) => {
      const result = await createGeneratedCampaign(input(sku));

      expect(result).toBeNull();
      expect(mockPrisma.automation.create).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalledWith(
        "[create-generated] skip_invalid_catalogue_reference",
        expect.stringContaining(
          "the SKU does not normalize into a catalogue reference",
        ),
      );
    },
  );

  it("returns null for a SKU without a digit and creates nothing", async () => {
    const result = await createGeneratedCampaign(input("VINYL"));

    expect(result).toBeNull();
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      "[create-generated] skip_invalid_catalogue_reference",
      expect.stringContaining("at least one digit"),
    );
  });

  it("keeps the generic behaviour for an explicit null (instore)", async () => {
    const result = await createGeneratedCampaign(input(null));

    expect(result).not.toBeNull();
    expect(mockPrisma.automation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          catnoTag: null,
          pendingNextReel: true,
          name: "LM02 release",
        }),
      }),
    );
    // No catalogue reference, so the UTM campaign is the name slug.
    const createArgs = mockPrisma.automation.create.mock.calls[0][0];
    expect(createArgs.data.trackedLinks.create[0].destinationUrl).toBe(
      "https://yoyaku.io/release/lm02/?utm_source=instagram&utm_medium=dm&utm_campaign=lm02-release",
    );
  });

  it("stores the normalized reference and tags the link with it", async () => {
    const result = await createGeneratedCampaign(input("LM-02"));

    expect(result).not.toBeNull();
    expect(mockPrisma.automation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          catnoTag: "LM02",
          pendingNextReel: true,
        }),
      }),
    );
    const createArgs = mockPrisma.automation.create.mock.calls[0][0];
    expect(createArgs.data.trackedLinks.create[0].destinationUrl).toBe(
      "https://yoyaku.io/release/lm02/?utm_source=instagram&utm_medium=dm&utm_campaign=lm02",
    );
  });
});
