import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  upsert: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: {
    instagramAccount: {
      findUnique: mocks.findUnique,
      update: mocks.update,
    },
    instagramCapability: {
      upsert: mocks.upsert,
    },
    $transaction: mocks.transaction,
  },
}));

import { recordInstagramWebhookCapability } from "../lib/meta/capabilities";

describe("recordInstagramWebhookCapability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue({ subscribedFields: ["messages"] });
    mocks.update.mockResolvedValue({});
    mocks.transaction.mockImplementation(async (operations: unknown[]) =>
      Promise.all(operations),
    );
  });

  it("records webhook delivery without promoting functional API capability", async () => {
    mocks.upsert.mockImplementation(() => {
      throw new Error("webhook receipt must not promote API capability");
    });

    await expect(
      recordInstagramWebhookCapability("account-1", "COMMENTS"),
    ).resolves.toBeUndefined();

    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "account-1" },
        data: expect.objectContaining({
          subscribedFields: ["messages", "comments"],
          webhookSubscribed: true,
          lastCommentWebhookAt: expect.any(Date),
        }),
      }),
    );
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});
