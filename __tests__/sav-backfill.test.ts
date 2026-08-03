import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockMeta, mockIngest } = vi.hoisted(() => ({
  mockPrisma: { instagramAccount: { findMany: vi.fn() } },
  mockMeta: {
    getConversations: vi.fn(),
    getConversationMessages: vi.fn(),
  },
  mockIngest: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/meta/client", () => mockMeta);
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: () => "access-token" }));
vi.mock("@/lib/sav/service", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/sav/service")>();
  return { ...original, ingestSavInboundEvent: mockIngest };
});

import { POST } from "@/app/api/internal/sav/backfill/route";

const TOKEN = "bridge-token-that-is-longer-than-thirty-two-characters";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-03T17:00:00.000Z"));
  vi.clearAllMocks();
  vi.stubEnv("SAV_BRIDGE_TOKEN", TOKEN);
  mockPrisma.instagramAccount.findMany.mockResolvedValue([{
    id: "account_row_1",
    instagramId: "ig_business",
    username: "yoyaku.fr",
    accessToken: "encrypted",
    connectedAt: new Date("2026-01-01T00:00:00Z"),
  }]);
  mockMeta.getConversations.mockResolvedValue([{
    id: "conversation_1",
    participants: { data: [
      { id: "ig_business", username: "yoyaku.fr" },
      { id: "ig_customer", username: "eelco" },
    ] },
  }]);
  mockMeta.getConversationMessages.mockResolvedValue([
    {
      id: "outbound_aug3",
      created_time: "2026-08-03T07:01:00.000Z",
      message: "Ok let me check now",
      from: { id: "ig_business", username: "yoyaku.fr" },
    },
    {
      id: "followup_aug3",
      created_time: "2026-08-03T06:59:00.000Z",
      message: "Can you please look into that order?",
      from: { id: "ig_customer", username: "eelco" },
    },
    {
      id: "order_jul9",
      created_time: "2026-07-09T09:51:00.000Z",
      message: "I need help with order 745614",
      from: { id: "ig_customer", username: "eelco" },
    },
  ]);
  mockIngest.mockResolvedValue({ status: "created", id: "item_fresh" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("bounded SAV backfill", () => {
  it("uses an old order reference to enqueue the latest inbound and its context", async () => {
    const request = new Request("http://localhost/api/internal/sav/backfill", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ orderReference: "745614", accountKey: "yoyaku_fr" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { found: true, imported: true, itemId: "item_fresh" },
    });

    expect(mockIngest).toHaveBeenCalledTimes(1);
    const [event, options] = mockIngest.mock.calls[0];
    expect(event).toMatchObject({
      metaMessageId: "followup_aug3",
      text: "Can you please look into that order?",
      receivedAt: new Date("2026-08-03T06:59:00.000Z"),
    });
    expect(options.graphConversationId).toBe("conversation_1");
    expect(options.contextMessages).toEqual([
      expect.objectContaining({ metaMessageId: "order_jul9", direction: "INBOUND" }),
      expect.objectContaining({ metaMessageId: "followup_aug3", direction: "INBOUND" }),
      expect.objectContaining({ metaMessageId: "outbound_aug3", direction: "OUTBOUND" }),
    ]);
  });
});
