import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { labMocks, accessMocks, labAccessMocks, dbMocks } = vi.hoisted(() => ({
  labMocks: {
    getPromptVersions: vi.fn(),
    createPromptVersion: vi.fn(),
    activateDraft: vi.fn(),
    revertToPrompt: vi.fn(),
    addGoldenExample: vi.fn(),
    removeGoldenExample: vi.fn(),
    makeExampleFromGeneration: vi.fn(),
    exampleFromCampaign: vi.fn(),
    searchCampaignsForExamples: vi.fn(),
    getLabMetrics: vi.fn(),
    getRecentGenerations: vi.fn(),
    createTrialRun: vi.fn(),
    getTrialResults: vi.fn(),
    verdictFromItems: vi.fn(),
  },
  accessMocks: {
    getCurrentWorkspaceContext: vi.fn(),
  },
  labAccessMocks: {
    canWriteLab: vi.fn(),
  },
  dbMocks: {
    userFindUnique: vi.fn(),
  },
}));

vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: accessMocks.getCurrentWorkspaceContext,
  // Same contract as the real helper: editor and above may manage.
  canManageCampaigns: (role: string) => ["EDITOR", "ADMIN", "OWNER"].includes(role),
}));
vi.mock("@/lib/copywriter/lab-access", () => ({
  canReadLab: (role: string) => ["EDITOR", "ADMIN", "OWNER"].includes(role),
  canWriteLab: labAccessMocks.canWriteLab,
}));
// Real error class so the route error mapping is exercised as shipped.
vi.mock("@/lib/copywriter/service", () => ({
  CopywriterError: class CopywriterError extends Error {
    constructor(
      public readonly code: string,
      public readonly status: number
    ) {
      super(code);
      this.name = "CopywriterError";
    }
  },
}));
vi.mock("@/lib/copywriter/lab", () => labMocks);
vi.mock("@/lib/db/client", () => ({
  prisma: { user: { findUnique: dbMocks.userFindUnique } },
}));

import { GET as getPrompts, POST as postPrompts } from "@/app/api/copywriter/prompts/route";
import { POST as postRevert } from "@/app/api/copywriter/prompts/[id]/revert/route";
import { GET as getMetrics } from "@/app/api/copywriter/metrics/route";
import { GET as getGenerations } from "@/app/api/copywriter/generations/route";
import { GET as getTrials, POST as postTrials } from "@/app/api/copywriter/trials/route";
import { GET as getCampaigns } from "@/app/api/copywriter/campaigns/route";

function ctx(role: "OWNER" | "EDITOR" | "MEMBER" | null) {
  return role ? { userId: "user_1", workspaceId: "workspace_1", role } : null;
}

const json = (body: unknown) =>
  new NextRequest("http://localhost/x", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  accessMocks.getCurrentWorkspaceContext.mockResolvedValue(ctx("OWNER"));
  labAccessMocks.canWriteLab.mockResolvedValue(true);
  dbMocks.userFindUnique.mockResolvedValue({ email: "owner@yoyaku.fr" });
  labMocks.getPromptVersions.mockResolvedValue({
    versions: [{ id: "p1", version: 1, isActive: true }],
    active: { id: "p1", version: 1, isActive: true },
  });
  labMocks.getLabMetrics.mockResolvedValue([]);
  labMocks.getRecentGenerations.mockResolvedValue([]);
  labMocks.getTrialResults.mockResolvedValue([{ id: "t1" }]);
  labMocks.verdictFromItems.mockReturnValue({ ready: true, trialPass: 5, baselinePass: 4, baselinesFound: 5, gateOk: true });
  labMocks.createTrialRun.mockResolvedValue({ ids: ["t1", "t2"] });
  labMocks.createPromptVersion.mockResolvedValue({ id: "p2", version: 2 });
  labMocks.revertToPrompt.mockResolvedValue({ id: "p3", version: 3 });
  labMocks.searchCampaignsForExamples.mockResolvedValue([]);
});

describe("read routes (editor may read)", () => {
  it("owner reads prompts, metrics, generations", async () => {
    const [prompts, metrics, generations] = await Promise.all([
      getPrompts(),
      getMetrics(),
      getGenerations(new NextRequest("http://localhost/x?limit=20")),
    ]);
    expect([prompts.status, metrics.status, generations.status]).toEqual([200, 200, 200]);
    expect(labMocks.getRecentGenerations).toHaveBeenCalledWith("workspace_1", 20);
    for (const response of [prompts, metrics, generations]) {
      expect(response.headers.get("cache-control")).toContain("no-store");
    }
  });

  it("an editor may read the lab but sees canWrite=false", async () => {
    accessMocks.getCurrentWorkspaceContext.mockResolvedValue(ctx("EDITOR"));
    labAccessMocks.canWriteLab.mockResolvedValue(false);
    const response = await getPrompts();
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.data.canWrite).toBe(false);
  });

  it("a member gets 403 on every read route", async () => {
    accessMocks.getCurrentWorkspaceContext.mockResolvedValue(ctx("MEMBER"));
    const responses = await Promise.all([
      getPrompts(),
      getMetrics(),
      getGenerations(new NextRequest("http://localhost/x")),
      getTrials(new NextRequest("http://localhost/x?ids=t1")),
      getCampaigns(new NextRequest("http://localhost/x?q=LM")),
    ]);
    expect(responses.map((r) => r.status)).toEqual([403, 403, 403, 403, 403]);
    expect(labMocks.getLabMetrics).not.toHaveBeenCalled();
    expect(labMocks.getRecentGenerations).not.toHaveBeenCalled();
  });

  it("an anonymous call gets 401", async () => {
    accessMocks.getCurrentWorkspaceContext.mockResolvedValue(ctx(null));
    const response = await getMetrics();
    expect(response.status).toBe(401);
  });
});

describe("write routes (owner only)", () => {
  it("an editor gets 403 on every write route", async () => {
    accessMocks.getCurrentWorkspaceContext.mockResolvedValue(ctx("EDITOR"));
    labAccessMocks.canWriteLab.mockResolvedValue(false);
    const responses = await Promise.all([
      postPrompts(
        json({ body: "b {{state}}", model: "haiku", reason: "r" })
      ),
      postRevert(json({ reason: "r" }), { params: Promise.resolve({ id: "p1" }) }),
      postTrials(json({ body: "b {{state}}", model: "haiku" })),
    ]);
    expect(responses.map((r) => r.status)).toEqual([403, 403, 403]);
    expect(labMocks.createPromptVersion).not.toHaveBeenCalled();
    expect(labMocks.revertToPrompt).not.toHaveBeenCalled();
    expect(labMocks.createTrialRun).not.toHaveBeenCalled();
  });

  it("a member gets 403 on every write route too", async () => {
    accessMocks.getCurrentWorkspaceContext.mockResolvedValue(ctx("MEMBER"));
    labAccessMocks.canWriteLab.mockResolvedValue(false);
    const response = await postPrompts(
      json({ body: "b {{state}}", model: "haiku", reason: "r" })
    );
    expect(response.status).toBe(403);
    expect(labMocks.createPromptVersion).not.toHaveBeenCalled();
  });

  it("creates a new version and returns the refreshed history", async () => {
    const response = await postPrompts(
      json({ body: "NEW {{state}}", model: "sonnet", reason: "tighter rules" })
    );
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.data.active.version).toBe(1);
    expect(labMocks.createPromptVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace_1",
        body: "NEW {{state}}",
        model: "sonnet",
        reason: "tighter rules",
        authorEmail: "owner@yoyaku.fr",
        activate: false,
      })
    );
  });

  it("maps a missing prompt field to its stable 400 code", async () => {
    const response = await postPrompts(json({ body: "NEW {{state}}" }));
    const payload = await response.json();
    expect(response.status).toBe(400);
    expect(payload.error).toBe("INVALID_BODY");
    expect(labMocks.createPromptVersion).not.toHaveBeenCalled();
  });

  it("maps a service error code 1:1", async () => {
    labMocks.createPromptVersion.mockRejectedValue(
      new (await import("@/lib/copywriter/service")).CopywriterError(
        "UNKNOWN_PLACEHOLDER",
        400
      )
    );
    const response = await postPrompts(
      json({ body: "b", model: "haiku", reason: "r" })
    );
    const payload = await response.json();
    expect(response.status).toBe(400);
    expect(payload.error).toBe("UNKNOWN_PLACEHOLDER");
  });

  it("reverts with a required reason and never mutates the target", async () => {
    const ok = await postRevert(json({ reason: "back to v1" }), {
      params: Promise.resolve({ id: "p1" }),
    });
    expect(ok.status).toBe(200);
    expect(labMocks.revertToPrompt).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      promptId: "p1",
      reason: "back to v1",
      authorEmail: "owner@yoyaku.fr",
    });

    const missing = await postRevert(json({}), {
      params: Promise.resolve({ id: "p1" }),
    });
    expect(missing.status).toBe(400);
    expect(labMocks.revertToPrompt).toHaveBeenCalledTimes(1);
  });

  it("trials: owner creates a run; the stable 409 code travels", async () => {
    const ok = await postTrials(json({ body: "b {{state}}", model: "haiku" }));
    const payload = await ok.json();
    expect(ok.status).toBe(200);
    expect(payload.data.ids).toEqual(["t1", "t2"]);
    expect(labMocks.createTrialRun).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "workspace_1", model: "haiku" })
    );

    labMocks.createTrialRun.mockRejectedValue(
      new (await import("@/lib/copywriter/service")).CopywriterError(
        "TRIAL_IN_PROGRESS",
        409
      )
    );
    const refused = await postTrials(json({ body: "b {{state}}", model: "haiku" }));
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toBe("TRIAL_IN_PROGRESS");
  });

  it("trials GET returns results plus the gate verdict", async () => {
    const response = await getTrials(new NextRequest("http://localhost/x?ids=t1,t2"));
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.data.verdict.gateOk).toBe(true);
    // The verdict is computed from the rows already fetched, not a second
    // round of queries.
    expect(labMocks.getTrialResults).toHaveBeenCalledWith("workspace_1", ["t1", "t2"]);
    expect(labMocks.verdictFromItems).toHaveBeenCalledWith([{ id: "t1" }]);
  });

  it("trials GET without ids is a stable 400", async () => {
    const response = await getTrials(new NextRequest("http://localhost/x"));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("INVALID_TRIAL_IDS");
  });

  it("make-it-an-example goes through POST /prompts and refuses a finalCopy-less generation", async () => {
    labMocks.makeExampleFromGeneration.mockRejectedValue(
      new (await import("@/lib/copywriter/service")).CopywriterError("NO_FINAL_COPY", 400)
    );
    const response = await postPrompts(json({ addExample: { generationId: "g1" } }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("NO_FINAL_COPY");
  });

  it("campaign search passes the query through", async () => {
    const response = await getCampaigns(
      new NextRequest("http://localhost/x?q=likemind")
    );
    expect(response.status).toBe(200);
    expect(labMocks.searchCampaignsForExamples).toHaveBeenCalledWith(
      "workspace_1",
      "likemind"
    );
  });
});
