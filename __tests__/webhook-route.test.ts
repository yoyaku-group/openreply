import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "crypto";

const { mockPrisma, mockQueue, mockIngest } = vi.hoisted(() => ({
  mockPrisma: {
    webhookEvent: { create: vi.fn(), update: vi.fn() },
    operationalEvent: { create: vi.fn() },
    instagramAccount: { findUnique: vi.fn() },
    dmLog: { findMany: vi.fn() },
  },
  mockQueue: { add: vi.fn() },
  mockIngest: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => mockQueue,
  POSTBACK_JOB_NAME: "process-postback",
}));
vi.mock("@/lib/sav/service", () => ({ ingestSavInboundEvent: mockIngest }));

import { POST } from "@/app/api/webhook/route";

const SECRET = "webhook-secret";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("FACEBOOK_APP_SECRET", SECRET);
  vi.stubEnv("INSTAGRAM_APP_SECRET", "");
  mockPrisma.webhookEvent.create.mockResolvedValue({ id: "event_1" });
  mockPrisma.webhookEvent.update.mockResolvedValue({});
  mockPrisma.dmLog.findMany.mockResolvedValue([]);
  mockIngest.mockResolvedValue({ status: "created", id: "item_1" });
});

describe("webhook SAV ingress", () => {
  it("persists only a redacted audit while passing plaintext directly to encryption", async () => {
    const payload = {
      object: "instagram",
      entry: [{
        id: "ig_business",
        time: 1_722_500_000,
        messaging: [{
          sender: { id: "ig_customer", username: "eelco" },
          recipient: { id: "ig_business" },
          timestamp: 1_722_500_001_000,
          message: {
            mid: "mid_1",
            text: "Please check order 745614",
            attachments: [{ payload: { url: "https://private.example/image" } }],
          },
        }],
      }],
    };
    const raw = JSON.stringify(payload);
    const signature = `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;
    const request = new Request("http://localhost/api/webhook", {
      method: "POST",
      headers: { "x-hub-signature-256": signature },
      body: raw,
    });

    const response = await POST(request as never);
    expect(response.status).toBe(200);
    const persisted = mockPrisma.webhookEvent.create.mock.calls[0][0].data.payload;
    const serialized = JSON.stringify(persisted);
    expect(serialized).not.toContain("745614");
    expect(serialized).not.toContain("eelco");
    expect(serialized).not.toContain("private.example");
    expect(serialized).toContain("mid_1");
    expect(mockIngest).toHaveBeenCalledWith(
      expect.objectContaining({
        metaMessageId: "mid_1",
        text: "Please check order 745614",
        hasAttachments: true,
      })
    );
  });
});
