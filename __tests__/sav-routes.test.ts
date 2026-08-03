import { beforeEach, describe, expect, it, vi } from "vitest";

const { serviceMocks, mockPrisma } = vi.hoisted(() => ({
  serviceMocks: {
    claimSavItems: vi.fn(),
    failSavItem: vi.fn(),
    getSavBridgeHealth: vi.fn(),
    holdSavItem: vi.fn(),
    ingestSavInboundEvent: vi.fn(),
    markSavItemReviewed: vi.fn(),
    preflightSavItem: vi.fn(),
    sendSavReply: vi.fn(),
    SavBridgeError: class extends Error {},
  },
  mockPrisma: { instagramAccount: { findMany: vi.fn() } },
}));

vi.mock("@/lib/sav/service", () => serviceMocks);
vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import { GET as health } from "@/app/api/internal/sav/health/route";
import { POST as claim } from "@/app/api/internal/sav/claim/route";
import { POST as reviewed } from "@/app/api/internal/sav/items/[id]/reviewed/route";
import { POST as fail } from "@/app/api/internal/sav/items/[id]/fail/route";
import { POST as hold } from "@/app/api/internal/sav/items/[id]/hold/route";
import { POST as preflight } from "@/app/api/internal/sav/items/[id]/preflight/route";
import { POST as send } from "@/app/api/internal/sav/items/[id]/send/route";
import { POST as backfill } from "@/app/api/internal/sav/backfill/route";

const params = { params: Promise.resolve({ id: "item_1" }) };

function unauthorizedRequest(path: string, body?: unknown) {
  return new Request(`http://localhost${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer definitely-wrong" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SAV_BRIDGE_TOKEN", "correct-bridge-token-that-is-at-least-thirty-two");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("internal SAV route authentication", () => {
  it("fails closed on every endpoint before parsing input or querying services", async () => {
    const responses = await Promise.all([
      health(unauthorizedRequest("/api/internal/sav/health")),
      claim(unauthorizedRequest("/api/internal/sav/claim", {})),
      reviewed(unauthorizedRequest("/api/internal/sav/items/item_1/reviewed", {}), params),
      fail(unauthorizedRequest("/api/internal/sav/items/item_1/fail", {}), params),
      hold(unauthorizedRequest("/api/internal/sav/items/item_1/hold", {}), params),
      preflight(unauthorizedRequest("/api/internal/sav/items/item_1/preflight", {}), params),
      send(unauthorizedRequest("/api/internal/sav/items/item_1/send", {}), params),
      backfill(unauthorizedRequest("/api/internal/sav/backfill", {})),
    ]);
    expect(responses.map((response) => response.status)).toEqual(
      Array(8).fill(401)
    );
    expect(serviceMocks.claimSavItems).not.toHaveBeenCalled();
    expect(mockPrisma.instagramAccount.findMany).not.toHaveBeenCalled();
  });
});
