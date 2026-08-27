import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock prisma + debugToken BEFORE importing the module under test, so the
// module-level singletons see the mock implementations.
const instagramAccountFindUnique = vi.fn();
const instagramAccountFindMany = vi.fn();
const instagramAccountUpdate = vi.fn();
const debugToken = vi.fn();

vi.mock("../lib/db/client", () => ({
  prisma: {
    instagramAccount: {
      findUnique: (...args: unknown[]) => instagramAccountFindUnique(...args),
      findMany: (...args: unknown[]) => instagramAccountFindMany(...args),
      update: (...args: unknown[]) => instagramAccountUpdate(...args),
    },
  },
}));

vi.mock("../lib/meta/client", () => ({
  debugToken: (...args: unknown[]) => debugToken(...args),
}));

vi.mock("../lib/meta/oauth", () => ({
  decryptToken: () => "decrypted-token",
}));

import {
  REQUIRED_INSTAGRAM_SCOPES,
  MissingCommentScopeError,
  computeMissing,
  listCachedAccountScopes,
  probeAccountScopes,
} from "../lib/meta/scope-check";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("REQUIRED_INSTAGRAM_SCOPES", () => {
  it("contains the three Instagram Login scopes OpenReply depends on", () => {
    expect(REQUIRED_INSTAGRAM_SCOPES).toContain("instagram_business_basic");
    expect(REQUIRED_INSTAGRAM_SCOPES).toContain(
      "instagram_business_manage_messages"
    );
    expect(REQUIRED_INSTAGRAM_SCOPES).toContain(
      "instagram_business_manage_comments"
    );
  });

  it("is deduplicated", () => {
    expect(new Set(REQUIRED_INSTAGRAM_SCOPES).size).toBe(
      REQUIRED_INSTAGRAM_SCOPES.length
    );
  });
});

describe("computeMissing", () => {
  it("returns empty when all required scopes are granted", () => {
    expect(
      computeMissing([
        "instagram_business_basic",
        "instagram_business_manage_messages",
        "instagram_business_manage_comments",
      ])
    ).toEqual([]);
  });

  it("flags instagram_business_manage_comments as missing (the silent killer)", () => {
    const missing = computeMissing([
      "instagram_business_basic",
      "instagram_business_manage_messages",
    ]);
    expect(missing).toEqual(["instagram_business_manage_comments"]);
  });

  it("flags every scope missing when none are granted", () => {
    expect(computeMissing([])).toEqual([...REQUIRED_INSTAGRAM_SCOPES]);
  });

  it("ignores unknown scopes (forward-compat with future Meta scopes)", () => {
    expect(
      computeMissing([
        "instagram_business_basic",
        "instagram_business_manage_messages",
        "instagram_business_manage_comments",
        "instagram_business_manage_insights",
      ])
    ).toEqual([]);
  });
});

describe("MissingCommentScopeError", () => {
  it("carries the account, post, missing list, and a fix URL", () => {
    const error = new MissingCommentScopeError({
      accountId: "acct-123",
      accountUsername: "yoyaku.fr",
      postId: "media-456",
      missing: ["instagram_business_manage_comments"],
    });
    expect(error.code).toBe("MISSING_COMMENT_SCOPE");
    expect(error.accountId).toBe("acct-123");
    expect(error.accountUsername).toBe("yoyaku.fr");
    expect(error.postId).toBe("media-456");
    expect(error.missing).toEqual(["instagram_business_manage_comments"]);
    expect(error.fixUrl).toBe("/settings/instagram/reconnect");
    expect(error.message).toContain("@yoyaku.fr");
    expect(error.message).toContain("instagram_business_manage_comments");
  });
});

describe("probeAccountScopes (DB-cached path)", () => {
  const WORKSPACE_A = "workspace-a";
  it("returns the cached snapshot when lastScopeProbeAt is fresh", async () => {
    const probedAt = new Date();
    instagramAccountFindUnique.mockResolvedValue({
      id: "acct-1",
      username: "yoyaku.fr",
      workspaceId: WORKSPACE_A,
      accessToken: "encrypted",
      scopes: [
        "instagram_business_basic",
        "instagram_business_manage_messages",
        "instagram_business_manage_comments",
      ],
      lastScopeProbeAt: probedAt,
      archivedAt: null,
    });
    const result = await probeAccountScopes("acct-1", { workspaceId: WORKSPACE_A });
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.grantedScopes).toContain("instagram_business_manage_comments");
    expect(debugToken).not.toHaveBeenCalled();
  });

  it("returns missing scopes without hitting Meta when the cache is fresh-but-incomplete", async () => {
    instagramAccountFindUnique.mockResolvedValue({
      id: "acct-2",
      username: "yoyakurecordstore",
      workspaceId: WORKSPACE_A,
      accessToken: "encrypted",
      scopes: ["instagram_business_basic", "instagram_business_manage_messages"],
      lastScopeProbeAt: new Date(),
      archivedAt: null,
    });
    const result = await probeAccountScopes("acct-2", { workspaceId: WORKSPACE_A });
    // `ok` reflects probe success (cache hit = ok=true). The missing-scope
    // signal lives on `missing` — the assertion callers actually check.
    expect(result.missing).toEqual(["instagram_business_manage_comments"]);
    expect(debugToken).not.toHaveBeenCalled();
  });

  it("returns zero missing for archived accounts without probing Meta", async () => {
    instagramAccountFindUnique.mockResolvedValue({
      id: "acct-3",
      username: "archived-account",
      workspaceId: WORKSPACE_A,
      accessToken: "encrypted",
      scopes: [],
      lastScopeProbeAt: null,
      archivedAt: new Date(),
    });
    const result = await probeAccountScopes("acct-3", { workspaceId: WORKSPACE_A });
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(debugToken).not.toHaveBeenCalled();
  });

  it("throws CrossTenantAccessError when workspaceId mismatches", async () => {
    instagramAccountFindUnique.mockResolvedValue({
      id: "acct-other",
      username: "other",
      workspaceId: "workspace-b",
      accessToken: "encrypted",
      scopes: ["instagram_business_basic"],
      lastScopeProbeAt: new Date(),
      archivedAt: null,
    });
    await expect(
      probeAccountScopes("acct-other", { workspaceId: WORKSPACE_A })
    ).rejects.toMatchObject({ code: "CROSS_TENANT_ACCESS" });
    expect(debugToken).not.toHaveBeenCalled();
  });
});

describe("probeAccountScopes (live-probe path)", () => {
  const WORKSPACE_A = "workspace-a";
  it("calls debugToken when the cache is stale and writes the result back", async () => {
    instagramAccountFindUnique.mockResolvedValue({
      id: "acct-4",
      username: "yoyaku.fr",
      workspaceId: WORKSPACE_A,
      accessToken: "encrypted",
      scopes: [],
      // Two hours ago — past the 1h cache TTL
      lastScopeProbeAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      archivedAt: null,
    });
    debugToken.mockResolvedValue({
      data: {
        scopes: [
          "instagram_business_basic",
          "instagram_business_manage_messages",
          "instagram_business_manage_comments",
        ],
      },
    });
    instagramAccountUpdate.mockResolvedValue({});
    const result = await probeAccountScopes("acct-4", { workspaceId: WORKSPACE_A });
    expect(debugToken).toHaveBeenCalledTimes(1);
    expect(instagramAccountUpdate).toHaveBeenCalledWith({
      where: { id: "acct-4" },
      data: {
        scopes: [
          "instagram_business_basic",
          "instagram_business_manage_messages",
          "instagram_business_manage_comments",
        ],
        lastScopeProbeAt: expect.any(Date),
      },
    });
    expect(result.missing).toEqual([]);
  });

  it("survives Meta errors with the cached scopes and an error field", async () => {
    instagramAccountFindUnique.mockResolvedValue({
      id: "acct-5",
      username: "yoyaku.fr",
      workspaceId: WORKSPACE_A,
      accessToken: "encrypted",
      scopes: ["instagram_business_basic"],
      lastScopeProbeAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      archivedAt: null,
    });
    debugToken.mockRejectedValue(new Error("rate-limited"));
    const result = await probeAccountScopes("acct-5", { workspaceId: WORKSPACE_A });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("rate-limited");
    expect(result.missing).toContain("instagram_business_manage_comments");
    expect(result.missing).toContain("instagram_business_manage_messages");
  });
});

describe("listCachedAccountScopes", () => {
  it("returns a snapshot per non-archived account", async () => {
    instagramAccountFindMany.mockResolvedValue([
      {
        id: "a",
        username: "yoyaku.fr",
        scopes: [
          "instagram_business_basic",
          "instagram_business_manage_messages",
          "instagram_business_manage_comments",
        ],
        lastScopeProbeAt: new Date(),
        archivedAt: null,
      },
      {
        id: "b",
        username: "yoyakurecordstore",
        scopes: ["instagram_business_basic"],
        lastScopeProbeAt: null,
        archivedAt: null,
      },
    ]);
    const rows = await listCachedAccountScopes();
    expect(rows).toHaveLength(2);
    expect(rows[0].missing).toEqual([]);
    expect(rows[1].missing).toEqual([
      "instagram_business_manage_messages",
      "instagram_business_manage_comments",
    ]);
    expect(instagramAccountFindMany).toHaveBeenCalledWith({
      where: { archivedAt: null },
      select: expect.any(Object),
      orderBy: { connectedAt: "asc" },
    });
  });
});
