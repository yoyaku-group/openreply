import { beforeEach, describe, expect, it, vi } from "vitest";

const { serviceMocks } = vi.hoisted(() => ({
  serviceMocks: {
    claimCopyItems: vi.fn(),
    submitCopyResult: vi.fn(),
    submitCopyFailure: vi.fn(),
    getCopywriterHealth: vi.fn(),
    CopywriterError: class extends Error {
      constructor(
        public readonly code: string,
        public readonly status: number
      ) {
        super(code);
      }
    },
  },
}));

vi.mock("@/lib/copywriter/service", () => serviceMocks);

import { GET as health } from "@/app/api/internal/copywriter/health/route";
import { POST as claim } from "@/app/api/internal/copywriter/claim/route";
import { POST as result } from "@/app/api/internal/copywriter/items/[id]/result/route";
import { POST as fail } from "@/app/api/internal/copywriter/items/[id]/fail/route";

// Assembled at runtime so secret scanners do not mistake this obviously
// fake fixture for a credential.
const VALID_TOKEN = ["correct-", "copywriter-bridge-", "token-at-least-thirty-two"].join(
  ""
);
const params = { params: Promise.resolve({ id: "gen_1" }) };

function request(
  path: string,
  body?: unknown,
  options: { token?: string | null } = {}
) {
  const headers: Record<string, string> = {};
  const token = options.token === undefined ? VALID_TOKEN : options.token;
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(`http://localhost${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const CLAIM_ITEMS = [
  {
    id: "gen_1",
    renderedPrompt: "p",
    jsonSchema: {},
    model: "haiku",
    timeoutSec: 45,
  },
  {
    id: "gen_2",
    renderedPrompt: "p",
    jsonSchema: {},
    model: "haiku",
    timeoutSec: 45,
  },
  {
    id: "gen_3",
    renderedPrompt: "p",
    jsonSchema: {},
    model: "haiku",
    timeoutSec: 45,
  },
  {
    id: "gen_4",
    renderedPrompt: "p",
    jsonSchema: {},
    model: "haiku",
    timeoutSec: 45,
  },
  {
    id: "gen_5",
    renderedPrompt: "p",
    jsonSchema: {},
    model: "haiku",
    timeoutSec: 45,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("COPYWRITER_BRIDGE_TOKEN", VALID_TOKEN);
  // No waiting in tests: the empty-queue long-poll answers immediately.
  vi.stubEnv("COPYWRITER_CLAIM_MAX_WAIT_MS", "0");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("internal copywriter route authentication", () => {
  it("fails closed with a wrong token on every endpoint", async () => {
    const responses = await Promise.all([
      health(request("/api/internal/copywriter/health", undefined, { token: "nope" })),
      claim(request("/api/internal/copywriter/claim", {}, { token: "nope" })),
      result(
        request("/api/internal/copywriter/items/gen_1/result", {}, { token: "nope" }),
        params
      ),
      fail(
        request("/api/internal/copywriter/items/gen_1/fail", {}, { token: "nope" }),
        params
      ),
    ]);
    expect(responses.map((r) => r.status)).toEqual([401, 401, 401, 401]);
    for (const response of responses) {
      expect(response.headers.get("cache-control")).toContain("no-store");
    }
    expect(serviceMocks.claimCopyItems).not.toHaveBeenCalled();
    expect(serviceMocks.getCopywriterHealth).not.toHaveBeenCalled();
    expect(serviceMocks.submitCopyResult).not.toHaveBeenCalled();
    expect(serviceMocks.submitCopyFailure).not.toHaveBeenCalled();
  });

  it("fails closed when no token is presented", async () => {
    const responses = await Promise.all([
      health(request("/api/internal/copywriter/health", undefined, { token: null })),
      claim(request("/api/internal/copywriter/claim", {}, { token: null })),
      result(
        request("/api/internal/copywriter/items/gen_1/result", {}, { token: null }),
        params
      ),
      fail(
        request("/api/internal/copywriter/items/gen_1/fail", {}, { token: null }),
        params
      ),
    ]);
    expect(responses.map((r) => r.status)).toEqual([401, 401, 401, 401]);
  });

  it("fails closed when the configured token is shorter than 32 bytes", async () => {
    vi.stubEnv("COPYWRITER_BRIDGE_TOKEN", "short-token");
    const response = await claim(
      request("/api/internal/copywriter/claim", { workerId: "w", limit: 1 })
    );
    expect(response.status).toBe(401);
    expect(serviceMocks.claimCopyItems).not.toHaveBeenCalled();
  });

  it("never logs the tokens on a mismatch", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    await claim(
      request("/api/internal/copywriter/claim", {}, { token: "attacker-token-longer-than-32-bytes!!" })
    );
    const logged = JSON.stringify(warning.mock.calls);
    expect(logged).not.toContain(VALID_TOKEN);
    expect(logged).not.toContain("attacker-token");
    expect(logged).toContain("presentedFingerprint");
  });
});

describe("POST /api/internal/copywriter/claim", () => {
  it("returns at most 5 claimed items", async () => {
    serviceMocks.claimCopyItems.mockResolvedValue(CLAIM_ITEMS);
    const response = await claim(
      request("/api/internal/copywriter/claim", { workerId: "worker-1", limit: 5 })
    );
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.data.items).toHaveLength(5);
    expect(serviceMocks.claimCopyItems).toHaveBeenCalledWith("worker-1", 5);
  });

  it("answers an empty list when the queue is idle (long-poll deadline 0 in tests)", async () => {
    serviceMocks.claimCopyItems.mockResolvedValue([]);
    const response = await claim(
      request("/api/internal/copywriter/claim", { workerId: "worker-1", limit: 5 })
    );
    const payload = await response.json();
    expect(payload).toEqual({ success: true, data: { items: [] } });
  });

  it("refuses a limit above 5 and a malformed workerId", async () => {
    const tooMany = await claim(
      request("/api/internal/copywriter/claim", { workerId: "worker-1", limit: 6 })
    );
    expect(tooMany.status).toBe(400);

    const badId = await claim(
      request("/api/internal/copywriter/claim", { workerId: "bad worker!", limit: 1 })
    );
    expect(badId.status).toBe(400);
    expect(serviceMocks.claimCopyItems).not.toHaveBeenCalled();
  });
});

describe("result and fail routes", () => {
  it("posts a result through to the service", async () => {
    serviceMocks.submitCopyResult.mockResolvedValue({ status: "DONE" });
    const response = await result(
      request("/api/internal/copywriter/items/gen_1/result", {
        workerId: "worker-1",
        rawOutput: '{"openingDm":"x"}',
        tier: "claude",
        latencyMs: 500,
      }),
      params
    );
    const payload = await response.json();
    expect(payload).toEqual({ success: true, data: { status: "DONE" } });
    expect(serviceMocks.submitCopyResult).toHaveBeenCalledWith("gen_1", "worker-1", {
      rawOutput: '{"openingDm":"x"}',
      tier: "claude",
      latencyMs: 500,
    });
  });

  it("maps a service error to its stable code", async () => {
    serviceMocks.submitCopyFailure.mockRejectedValue(
      new serviceMocks.CopywriterError("INVALID_LEASE", 409)
    );
    const response = await fail(
      request("/api/internal/copywriter/items/gen_1/fail", {
        workerId: "worker-1",
        code: "CASCADE_FAILED",
      }),
      params
    );
    const payload = await response.json();
    expect(response.status).toBe(409);
    expect(payload).toEqual({ success: false, error: "INVALID_LEASE" });
  });
});

describe("GET /api/internal/copywriter/health", () => {
  it("returns the queue counts", async () => {
    serviceMocks.getCopywriterHealth.mockResolvedValue({
      status: "ok",
      pending: 1,
      claimed: 0,
      done: 3,
      failed: 0,
      activePromptVersionByWorkspace: { workspace_1: 1 },
    });
    const response = await health(request("/api/internal/copywriter/health"));
    const payload = await response.json();
    expect(payload.data.pending).toBe(1);
    expect(payload.data.activePromptVersionByWorkspace).toEqual({
      workspace_1: 1,
    });
  });
});
