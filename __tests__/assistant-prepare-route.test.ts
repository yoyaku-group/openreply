import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockPrisma, mockFetch } = vi.hoisted(() => ({
  mockPrisma: {
    instagramAccount: { findFirst: vi.fn() },
    $queryRaw: vi.fn(),
  },
  mockFetch: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: vi.fn(async () => ({
    workspaceId: "workspace_1",
    role: "OWNER",
  })),
  canManageCampaigns: vi.fn(() => true),
}));

import { POST } from "@/app/api/assistant/prepare/route";
import { clearAssistantProductCache } from "@/lib/assistant/resolve-product";

/** Real LM-02 public shop data (yoyaku.io), reference fixture. */
const LM02_STORE = {
  id: 746990,
  name: "Likemind 02",
  sku: "LM-02",
  slug: "nuro-fugue-nuron-likemind-02-lm-02",
  permalink: "https://yoyaku.io/release/nuro-fugue-nuron-likemind-02-lm-02/",
  images: [{ src: "https://yoyaku.io/wp-content/uploads/2026/07/front.jpg" }],
  short_description:
    "<p>Blueprint ARchives presents a reissue of Likemind 02, the 1994 UK split release by Nuron and Fugue.</p>",
  is_purchasable: true,
  is_in_stock: true,
  is_on_backorder: false,
  categories: [{ name: "Back in stock" }],
};

const LM02_ROUTES: Record<string, unknown> = {
  "/wp-json/wc/store/v1/products?slug=nuro-fugue-nuron-likemind-02-lm-02": [
    LM02_STORE,
  ],
  "/wp-json/wc/store/v1/products?sku=LM-02": [LM02_STORE],
  "/wp-json/wp/v2/product?slug=nuro-fugue-nuron-likemind-02-lm-02&_fields=id,musicartist,musiclabel":
    [{ id: 746990, musicartist: [28126, 28180], musiclabel: [42124] }],
  "/wp-json/wp/v2/musicartist?include=28126,28180&per_page=100&_fields=id,name": [
    { id: 28180, name: "Fugue" },
    { id: 28126, name: "Nuron" },
  ],
  "/wp-json/wp/v2/musiclabel?include=42124&per_page=100&_fields=id,name": [
    { id: 42124, name: "Blueprint ARchives" },
  ],
};

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function request(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/assistant/prepare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearAssistantProductCache();
  mockPrisma.instagramAccount.findFirst.mockResolvedValue({
    id: "account_1",
    workspaceId: "workspace_1",
    username: "yoyakurecordstore",
  });
  // Catalogue conflict checks are normalized SQL; empty by default.
  mockPrisma.$queryRaw.mockResolvedValue([]);
  mockFetch.mockImplementation(async (input: string | URL | Request) => {
    const href = input instanceof Request ? input.url : input.toString();
    const path = href.replace(/^https?:\/\/[^/]+/, "");
    if (!(path in LM02_ROUTES)) return jsonResponse([]);
    return jsonResponse(LM02_ROUTES[path]);
  });
  vi.stubGlobal("fetch", mockFetch);
});

describe("POST /api/assistant/prepare", () => {
  it("returns facts, caption, copy and lint for the LM-02 URL", async () => {
    const response = await POST(request({ product: "https://yoyaku.io/release/nuro-fugue-nuron-likemind-02-lm-02/" }) as never);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.data.facts).toMatchObject({
      sku: "LM-02",
      catnoTag: "LM02",
      hashtag: "#LM02",
      artists: ["Nuron", "Fugue"],
      label: "Blueprint ARchives",
      state: "restock",
    });
    expect(payload.data.caption.final).toBeNull();
    expect(payload.data.caption.additions).toEqual([
      "Comment to get the link!",
      "#LM02",
    ]);
    expect(payload.data.copy.ok).toBe(true);
    expect(payload.data.copy.provenance).toBe("standard");
    expect(payload.data.lint.ok).toBe(true);
    expect(payload.data.existingCampaign).toBeNull();
  });

  it("returns 404 PRODUCT_NOT_FOUND for an unknown SKU", async () => {
    const response = await POST(request({ product: "NOPE-1" }) as never);
    const payload = await response.json();

    expect(response.status).toBe(404);
    expect(payload.code).toBe("PRODUCT_NOT_FOUND");
  });

  it("returns 400 PRODUCT_URL_INVALID for a URL outside the shop host", async () => {
    const response = await POST(
      request({ product: "https://evil.example/release/abc001/" }) as never
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.code).toBe("PRODUCT_URL_INVALID");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed JSON body instead of a 500", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/assistant/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      }) as never
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.code).toBe("PRODUCT_URL_INVALID");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns 502 SHOP_UNAVAILABLE when the shop does not answer", async () => {
    mockFetch.mockRejectedValue(new Error("connection refused"));
    const response = await POST(request({ product: "LM-02" }) as never);
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload.code).toBe("SHOP_UNAVAILABLE");
  });

  it("detects an existing campaign on a legacy LM-02 row", async () => {
    // The production row stores the separator form `LM-02`; the normalized
    // SQL comparison must still match it against the canonical `LM02`.
    mockPrisma.$queryRaw.mockResolvedValueOnce([
      {
        id: "automation_lm02",
        name: "Campaign for @yoyakurecordstore",
        source: "MANUAL",
        lifecycle: "ACTIVE",
        isActive: true,
      },
    ]);

    const response = await POST(request({ product: "LM-02" }) as never);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.data.existingCampaign).toEqual({
      id: "automation_lm02",
      name: "Campaign for @yoyakurecordstore",
      status: "Active",
      source: "MANUAL",
    });
    // The conflict query runs on the canonical token, scoped to the account.
    const [template, ...params] = mockPrisma.$queryRaw.mock.calls[0];
    const sql = template.join("?");
    expect(sql).toContain(
      `upper(regexp_replace("catnoTag", '[^A-Za-z0-9]', '', 'g')) = ?`
    );
    expect(params).toContain("LM02");
    expect(params).toContain("account_1");
  });

  it("never creates or updates a campaign", async () => {
    await POST(request({ product: "LM-02" }) as never);
    expect(mockPrisma).not.toHaveProperty("automation");
    expect(mockFetch).toHaveBeenCalled();
  });
});
