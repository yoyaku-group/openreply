import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockTx, mockSendDirectMessage } = vi.hoisted(() => {
  const savTransportItem = {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
    count: vi.fn(),
  };
  const savConversationFence = {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
  };
  const tx = {
    savTransportItem,
    savConversationFence,
    $executeRaw: vi.fn(),
  };
  return {
    mockTx: tx,
    mockPrisma: {
      ...tx,
      instagramAccount: { findUnique: vi.fn() },
      $transaction: vi.fn(),
    },
    mockSendDirectMessage: vi.fn(),
  };
});

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/meta/client", () => ({ sendDirectMessage: mockSendDirectMessage }));

import {
  claimSavItems,
  ingestSavInboundEvent,
  preflightSavItem,
  sendSavReply,
} from "@/lib/sav/service";
import { encryptSavText } from "@/lib/sav/security";

const NOW = new Date("2026-08-03T17:00:00.000Z");

function baseItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "item_1",
    workspaceId: "workspace_1",
    instagramAccountId: "account_row_1",
    accountInstagramId: "ig_business",
    accountUsername: "yoyaku.fr",
    senderInstagramId: "ig_customer",
    senderUsername: "eelco",
    conversationKey: "ig_business:ig_customer",
    graphConversationId: "conversation_graph_1",
    conversationRevision: 1,
    metaMessageId: "mid_1",
    messageCiphertext: "ciphertext",
    messageFingerprint: "fingerprint",
    contextCiphertext: null,
    contextFingerprint: null,
    hasAttachments: false,
    receivedAt: new Date("2026-08-03T16:30:00.000Z"),
    replyWindowExpiresAt: new Date("2026-08-04T16:30:00.000Z"),
    state: "REVIEWED",
    attempts: 1,
    claimWorkerId: null,
    claimTokenHash: null,
    claimExpiresAt: null,
    reviewedAt: NOW,
    failureCode: null,
    deliveryTokenHash: null,
    deliveryTokenExpiresAt: null,
    deliveryIdempotencyKey: null,
    deliveryAttemptedAt: null,
    outboundFingerprint: null,
    metaReplyMessageId: null,
    sentAt: null,
    createdAt: new Date("2026-08-03T16:30:00.000Z"),
    updatedAt: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  vi.stubEnv("ENCRYPTION_KEY", "a".repeat(64));
  vi.stubEnv("SAV_SENDS_PER_HOUR", "10");
  mockPrisma.$transaction.mockImplementation(
    async (callback: (tx: typeof mockTx) => unknown) => callback(mockTx)
  );
  mockTx.$executeRaw.mockResolvedValue(0);
  mockPrisma.savTransportItem.deleteMany.mockResolvedValue({ count: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("claimSavItems", () => {
  it("uses an atomic lease so the same candidate cannot be claimed twice", async () => {
    const encrypted = encryptSavText("Order 745614");
    const candidate = baseItem({ state: "PENDING", messageCiphertext: encrypted });
    mockPrisma.savTransportItem.findMany.mockResolvedValue([candidate]);
    mockPrisma.savTransportItem.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    const first = await claimSavItems("worker-1", 1);
    const second = await claimSavItems("worker-2", 1);

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      text: "Order 745614",
      contextMessages: [expect.objectContaining({ text: "Order 745614" })],
      accountKey: "yoyaku_fr",
      conversationId: "conversation_graph_1",
    });
    expect(first[0].claimToken.length).toBeGreaterThan(32);
    expect(second).toEqual([]);
  });

  it("filters candidates by account before acquiring any lease", async () => {
    mockPrisma.savTransportItem.findMany.mockResolvedValue([]);
    await claimSavItems("canary", 1, ["yoyaku_fr"]);
    expect(mockPrisma.savTransportItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          accountUsername: { in: ["yoyaku.fr"] },
        }),
      })
    );
    expect(mockPrisma.savTransportItem.updateMany).not.toHaveBeenCalled();
  });
});

describe("ingestSavInboundEvent", () => {
  const event = {
    instagramAccountId: "ig_business",
    senderInstagramId: "ig_customer",
    senderUsername: "eelco",
    conversationId: "ig_business:ig_customer",
    metaMessageId: "mid_ingress",
    text: "Can you check order 745614?",
    receivedAt: NOW,
    hasAttachments: false,
  };

  it("deduplicates a replay by Meta message id before changing the fence", async () => {
    mockPrisma.instagramAccount.findUnique.mockResolvedValue({
      id: "account_row_1",
      workspaceId: "workspace_1",
      instagramId: "ig_business",
      username: "yoyaku.fr",
    });
    mockPrisma.savTransportItem.findUnique.mockResolvedValue({ id: "existing" });

    await expect(ingestSavInboundEvent(event)).resolves.toEqual({
      status: "duplicate",
      id: "existing",
    });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.savConversationFence.upsert).not.toHaveBeenCalled();
  });

  it("encrypts content and supersedes older actionable rows in one transaction", async () => {
    mockPrisma.instagramAccount.findUnique.mockResolvedValue({
      id: "account_row_1",
      workspaceId: "workspace_1",
      instagramId: "ig_business",
      username: "yoyaku.fr",
    });
    mockPrisma.savTransportItem.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    mockPrisma.savTransportItem.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.savConversationFence.upsert.mockResolvedValue({ revision: 3 });
    mockPrisma.savTransportItem.create.mockResolvedValue({ id: "new_item" });

    await expect(
      ingestSavInboundEvent(event, {
        graphConversationId: "conversation_1",
        contextMessages: [{
          direction: "INBOUND",
          text: "Order 745614",
          at: new Date(NOW.getTime() - 60_000).toISOString(),
          metaMessageId: "older_mid",
        }],
      })
    ).resolves.toEqual({ status: "created", id: "new_item" });

    expect(mockPrisma.savTransportItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          state: { in: ["PENDING", "CLAIMED", "REVIEWED"] },
        }),
        data: expect.objectContaining({
          state: "HOLD",
          failureCode: "SUPERSEDED_BY_NEW_INBOUND",
        }),
      })
    );
    const createData = mockPrisma.savTransportItem.create.mock.calls[0][0].data;
    expect(createData.messageCiphertext).not.toContain("745614");
    expect(createData.contextCiphertext).not.toContain("745614");
    expect(createData.conversationRevision).toBe(3);
    expect(createData.replyWindowExpiresAt.getTime() - NOW.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

describe("preflightSavItem", () => {
  it("classifies a superseded reviewed item as stale instead of invalid", async () => {
    mockPrisma.savTransportItem.findUnique.mockResolvedValue(
      baseItem({
        state: "HOLD",
        failureCode: "SUPERSEDED_BY_NEW_INBOUND",
      })
    );
    await expect(preflightSavItem("item_1", NOW)).resolves.toEqual({
      status: "STALE_CONTEXT",
    });
  });

  it("rejects an expired 24-hour reply window", async () => {
    mockPrisma.savTransportItem.findUnique.mockResolvedValue(
      baseItem({ replyWindowExpiresAt: new Date(NOW.getTime() - 1) })
    );
    await expect(preflightSavItem("item_1", NOW)).resolves.toEqual({
      status: "WINDOW_EXPIRED",
    });
  });

  it("rejects a proposal after a newer inbound message changed the fence", async () => {
    mockPrisma.savTransportItem.findUnique.mockResolvedValue(baseItem());
    mockPrisma.savConversationFence.findUnique.mockResolvedValue({ revision: 2 });
    await expect(preflightSavItem("item_1", NOW)).resolves.toEqual({
      status: "STALE_CONTEXT",
    });
  });

  it("issues a short-lived token only for the current revision", async () => {
    mockPrisma.savTransportItem.findUnique.mockResolvedValue(baseItem());
    mockPrisma.savConversationFence.findUnique.mockResolvedValue({ revision: 1 });
    mockPrisma.savTransportItem.updateMany.mockResolvedValue({ count: 1 });
    const result = await preflightSavItem("item_1", NOW);
    expect(result.status).toBe("READY");
    expect(result.deliveryToken?.length).toBeGreaterThan(32);
    expect(Date.parse(result.expiresAt!) - NOW.getTime()).toBe(5 * 60 * 1000);
  });
});

describe("sendSavReply", () => {
  it("classifies approval superseded after preflight as stale", async () => {
    mockPrisma.savTransportItem.findUnique.mockResolvedValue(
      baseItem({
        state: "HOLD",
        failureCode: "SUPERSEDED_BY_NEW_INBOUND",
        instagramAccount: { accessToken: encryptSavText("plain-access-token") },
      })
    );
    await expect(
      sendSavReply({
        id: "item_1",
        deliveryToken: "x".repeat(43),
        idempotencyKey: "approval:stale",
        text: "Reply",
        now: NOW,
      })
    ).resolves.toEqual({ status: "STALE_CONTEXT" });
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });

  it("returns ALREADY_SENT without touching Meta for a terminal or uncertain send", async () => {
    mockPrisma.savTransportItem.findUnique.mockResolvedValue(
      baseItem({ state: "SENT", metaReplyMessageId: "reply_1" })
    );
    await expect(
      sendSavReply({
        id: "item_1",
        deliveryToken: "x".repeat(43),
        idempotencyKey: "approval:1",
        text: "Reply",
        now: NOW,
      })
    ).resolves.toEqual({ status: "ALREADY_SENT", metaMessageId: "reply_1" });
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });

  it("revalidates the conversation fence before sending", async () => {
    const { tokenHash } = await import("@/lib/sav/security");
    const token = "d".repeat(43);
    mockPrisma.savTransportItem.findUnique.mockResolvedValue(
      baseItem({
        deliveryTokenHash: tokenHash(token),
        deliveryTokenExpiresAt: new Date(NOW.getTime() + 60_000),
        instagramAccount: { accessToken: encryptSavText("plain-access-token") },
      })
    );
    mockTx.savConversationFence.update.mockResolvedValue({ revision: 2 });

    await expect(
      sendSavReply({
        id: "item_1",
        deliveryToken: token,
        idempotencyKey: "approval:1",
        text: "Reply",
        now: NOW,
      })
    ).resolves.toEqual({ status: "STALE_CONTEXT" });
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });

  it("marks SENDING before Meta and records the message id exactly once", async () => {
    const { tokenHash } = await import("@/lib/sav/security");
    const token = "d".repeat(43);
    mockPrisma.savTransportItem.findUnique.mockResolvedValue(
      baseItem({
        deliveryTokenHash: tokenHash(token),
        deliveryTokenExpiresAt: new Date(NOW.getTime() + 60_000),
        instagramAccount: { accessToken: encryptSavText("plain-access-token") },
      })
    );
    mockTx.savConversationFence.update.mockResolvedValue({ revision: 1 });
    mockTx.savTransportItem.count.mockResolvedValue(0);
    mockTx.savTransportItem.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.savTransportItem.updateMany.mockResolvedValueOnce({ count: 1 });
    mockSendDirectMessage.mockResolvedValue({ recipient_id: "ig_customer", message_id: "reply_1" });

    await expect(
      sendSavReply({
        id: "item_1",
        deliveryToken: token,
        idempotencyKey: "approval:1",
        text: "Reply",
        now: NOW,
      })
    ).resolves.toEqual({ status: "SENT", metaMessageId: "reply_1" });
    expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
    expect(mockSendDirectMessage).toHaveBeenCalledWith(
      "plain-access-token",
      "ig_business",
      "ig_customer",
      "Reply"
    );
    expect(mockTx.savTransportItem.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({ deliveryAttemptedAt: null }),
        data: expect.objectContaining({ deliveryAttemptedAt: NOW }),
      })
    );
  });

  it("never lets the environment raise the immutable 10-attempt hard cap", async () => {
    const { tokenHash } = await import("@/lib/sav/security");
    const token = "c".repeat(43);
    vi.stubEnv("SAV_SENDS_PER_HOUR", "999");
    mockPrisma.savTransportItem.findUnique.mockResolvedValue(
      baseItem({
        deliveryTokenHash: tokenHash(token),
        deliveryTokenExpiresAt: new Date(NOW.getTime() + 60_000),
        instagramAccount: { accessToken: encryptSavText("plain-access-token") },
      })
    );
    mockTx.savConversationFence.update.mockResolvedValue({ revision: 1 });
    mockTx.savTransportItem.count.mockResolvedValue(10);

    await expect(
      sendSavReply({
        id: "item_1",
        deliveryToken: token,
        idempotencyKey: "approval:circuit",
        text: "Reply",
        now: NOW,
      })
    ).rejects.toMatchObject({ code: "CIRCUIT_OPEN", status: 429 });
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });

  it("counts every failed or uncertain reserved attempt by its immutable timestamp", async () => {
    const { tokenHash } = await import("@/lib/sav/security");
    const token = "e".repeat(43);
    mockPrisma.savTransportItem.findUnique.mockResolvedValue(
      baseItem({
        deliveryTokenHash: tokenHash(token),
        deliveryTokenExpiresAt: new Date(NOW.getTime() + 60_000),
        instagramAccount: { accessToken: encryptSavText("plain-access-token") },
      })
    );
    mockTx.savConversationFence.update.mockResolvedValue({ revision: 1 });
    // The aggregate includes rows in any state, including FAILED. Only the
    // immutable reservation timestamp defines membership in the hour window.
    mockTx.savTransportItem.count.mockResolvedValue(10);

    await expect(
      sendSavReply({
        id: "item_1",
        deliveryToken: token,
        idempotencyKey: "approval:failed-budget",
        text: "Reply",
        now: NOW,
      })
    ).rejects.toMatchObject({ code: "CIRCUIT_OPEN", status: 429 });

    expect(mockTx.savTransportItem.count).toHaveBeenCalledWith({
      where: {
        deliveryAttemptedAt: {
          gte: new Date(NOW.getTime() - 60 * 60 * 1000),
        },
      },
    });
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });

  it("serializes the global count before reserving a delivery attempt", async () => {
    const { tokenHash } = await import("@/lib/sav/security");
    const token = "s".repeat(43);
    mockPrisma.savTransportItem.findUnique.mockResolvedValue(
      baseItem({
        deliveryTokenHash: tokenHash(token),
        deliveryTokenExpiresAt: new Date(NOW.getTime() + 60_000),
        instagramAccount: { accessToken: encryptSavText("plain-access-token") },
      })
    );
    mockTx.savConversationFence.update.mockResolvedValue({ revision: 1 });
    mockTx.savTransportItem.count.mockResolvedValue(9);
    mockTx.savTransportItem.updateMany.mockResolvedValue({ count: 1 });
    mockSendDirectMessage.mockResolvedValue({
      recipient_id: "ig_customer",
      message_id: "reply_serialized",
    });

    await expect(
      sendSavReply({
        id: "item_1",
        deliveryToken: token,
        idempotencyKey: "approval:serialized",
        text: "Reply",
        now: NOW,
      })
    ).resolves.toEqual({
      status: "SENT",
      metaMessageId: "reply_serialized",
    });

    expect(mockTx.$executeRaw).toHaveBeenCalledTimes(1);
    const [queryParts, namespace, lockId] = mockTx.$executeRaw.mock.calls[0];
    expect(Array.from(queryParts as TemplateStringsArray).join(" ")).toContain(
      "pg_advisory_xact_lock"
    );
    expect([namespace, lockId]).toEqual([0x534156, 1]);
    const lockOrder = mockTx.$executeRaw.mock.invocationCallOrder[0];
    const countOrder = mockTx.savTransportItem.count.mock.invocationCallOrder[0];
    const reserveOrder = mockTx.savTransportItem.updateMany.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(countOrder);
    expect(countOrder).toBeLessThan(reserveOrder);
  });

  it("fails closed after an uncertain Meta error and preserves the idempotency key", async () => {
    const { tokenHash } = await import("@/lib/sav/security");
    const token = "f".repeat(43);
    mockPrisma.savTransportItem.findUnique.mockResolvedValue(
      baseItem({
        deliveryTokenHash: tokenHash(token),
        deliveryTokenExpiresAt: new Date(NOW.getTime() + 60_000),
        instagramAccount: { accessToken: encryptSavText("plain-access-token") },
      })
    );
    mockTx.savConversationFence.update.mockResolvedValue({ revision: 1 });
    mockTx.savTransportItem.count.mockResolvedValue(0);
    mockPrisma.savTransportItem.updateMany.mockResolvedValue({ count: 1 });
    mockSendDirectMessage.mockRejectedValue(new Error("network status unknown"));

    await expect(
      sendSavReply({
        id: "item_1",
        deliveryToken: token,
        idempotencyKey: "approval:uncertain",
        text: "Reply",
        now: NOW,
      })
    ).rejects.toMatchObject({ code: "META_SEND_FAILED", status: 502 });
    expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
    expect(mockPrisma.savTransportItem.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          deliveryIdempotencyKey: "approval:uncertain",
        }),
        data: expect.objectContaining({
          state: "FAILED",
          failureCode: "META_SEND_UNCERTAIN",
        }),
      })
    );
  });
});
