import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearAssistantProductCache,
  cleanProductDescription,
  resolveProduct,
  type ProductFacts,
} from "@/lib/assistant/resolve-product";

/**
 * Real LM-02 public shop data (yoyaku.io), used as the reference fixture.
 */
const LM02_STORE = {
  id: 746990,
  name: "Likemind 02",
  sku: "LM-02",
  slug: "nuro-fugue-nuron-likemind-02-lm-02",
  permalink: "https://yoyaku.io/release/nuro-fugue-nuron-likemind-02-lm-02/",
  images: [{ src: "https://yoyaku.io/wp-content/uploads/2026/07/front.jpg" }],
  short_description:
    "<p>Blueprint ARchives presents a reissue of Likemind 02, the 1994 UK split release by Nuron and Fugue. Four pieces of melodic, abstract techno pair Nuron&#8217;s “Mirage” and “In Motion” with Fugue&#8217;s “Contrapoint” and “Interlagos”.</p>",
  is_purchasable: true,
  is_in_stock: true,
  is_on_backorder: false,
  categories: [{ name: "Back in stock" }],
};

const LM02_PRODUCT_TERMS = [
  { id: 746990, musicartist: [28126, 28180], musiclabel: [42124] },
];

// The term endpoint returns names in its own order; the resolver must
// re-order to the id list (Nuron, Fugue), not the endpoint order.
const LM02_ARTISTS = [
  { id: 28180, name: "Fugue" },
  { id: 28126, name: "Nuron" },
];

const LM02_LABEL = [{ id: 42124, name: "Blueprint ARchives" }];

const LM02_EXPECTED_DESCRIPTION =
  "Blueprint ARchives presents a reissue of Likemind 02, the 1994 UK split release by Nuron and Fugue. Four pieces of melodic, abstract techno pair Nuron’s “Mirage” and “In Motion” with Fugue’s “Contrapoint” and “Interlagos”.";

const LM02_URL = "https://yoyaku.io/release/nuro-fugue-nuron-likemind-02-lm-02/";

interface RouteTable {
  [path: string]: unknown;
}

function fetchFromRoutes(routes: RouteTable) {
  const calls: string[] = [];
  const impl = (async (
    input: string | URL | Request,
  ) => {
    const href = input instanceof Request ? input.url : input.toString();
    calls.push(href);
    const path = href.replace(/^https?:\/\/[^/]+/, "");
    if (!(path in routes)) {
      return new Response("[]", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const body = routes[path];
    if (body instanceof Error) throw body;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { impl, calls };
}

const lm02Routes = (overrides: RouteTable = {}): RouteTable => ({
  "/wp-json/wc/store/v1/products?slug=nuro-fugue-nuron-likemind-02-lm-02": [
    LM02_STORE,
  ],
  "/wp-json/wc/store/v1/products?sku=LM-02": [LM02_STORE],
  "/wp-json/wp/v2/product?slug=nuro-fugue-nuron-likemind-02-lm-02&_fields=id,musicartist,musiclabel":
    LM02_PRODUCT_TERMS,
  "/wp-json/wp/v2/musicartist?include=28126,28180&per_page=100&_fields=id,name":
    LM02_ARTISTS,
  "/wp-json/wp/v2/musiclabel?include=42124&per_page=100&_fields=id,name":
    LM02_LABEL,
  ...overrides,
});

beforeEach(() => {
  clearAssistantProductCache();
});

describe("resolveProduct", () => {
  it("resolves the LM-02 fixture with artists re-ordered to the id list", async () => {
    const { impl } = fetchFromRoutes(lm02Routes());
    const result = await resolveProduct(LM02_URL, { fetchImpl: impl });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const facts: ProductFacts = result.facts;
    expect(facts.productId).toBe(746990);
    expect(facts.sku).toBe("LM-02");
    expect(facts.catnoTag).toBe("LM02");
    expect(facts.hashtag).toBe("#LM02");
    expect(facts.artists).toEqual(["Nuron", "Fugue"]);
    expect(facts.label).toBe("Blueprint ARchives");
    expect(facts.state).toBe("restock");
    expect(facts.permalink).toBe(LM02_URL);
    expect(facts.imageUrl).toBe(
      "https://yoyaku.io/wp-content/uploads/2026/07/front.jpg"
    );
    expect(facts.missing).toEqual([]);
  });

  it("strips HTML and decodes entities in the description", async () => {
    const { impl } = fetchFromRoutes(lm02Routes());
    const result = await resolveProduct(LM02_URL, { fetchImpl: impl });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts.description).toBe(LM02_EXPECTED_DESCRIPTION);
    expect(result.facts.description).not.toContain("<p>");
    expect(result.facts.description).not.toContain("&#8217;");
  });

  it("caps the description at 1200 characters and drops UI text", () => {
    const cleaned = cleanProductDescription(
      "<p>A great record.</p>Add to Wishlist<p>More copy.</p>"
    );
    expect(cleaned).toBe("A great record. More copy.");
    expect(cleaned).not.toContain("Add to Wishlist");

    const long = cleanProductDescription("x".repeat(1500));
    expect(long.length).toBeLessThanOrEqual(1200);
  });

  it("decodes out-of-range entities to nothing instead of throwing", () => {
    // &#9999999; is above 0x10FFFF: String.fromCodePoint would throw a
    // RangeError and fail the whole product read.
    expect(() => cleanProductDescription("<p>Limit &#9999999; here</p>")).not.toThrow();
    expect(cleanProductDescription("<p>Limit &#9999999; here</p>")).toBe(
      "Limit here"
    );
    expect(cleanProductDescription("&#8217;")).toBe("’");
  });

  it("entity-decodes the title, artist and label names", async () => {
    const { impl } = fetchFromRoutes({
      "/wp-json/wc/store/v1/products?sku=LM-02": [
        { ...LM02_STORE, name: "Likemind &#8217;02" },
      ],
      "/wp-json/wp/v2/product?slug=nuro-fugue-nuron-likemind-02-lm-02&_fields=id,musicartist,musiclabel":
        LM02_PRODUCT_TERMS,
      "/wp-json/wp/v2/musicartist?include=28126,28180&per_page=100&_fields=id,name":
        [
          { id: 28180, name: "Fugue &amp; Friends" },
          { id: 28126, name: "Nuron" },
        ],
      "/wp-json/wp/v2/musiclabel?include=42124&per_page=100&_fields=id,name": [
        { id: 42124, name: "Blueprint &#038; ARchives" },
      ],
    });
    const result = await resolveProduct("LM-02", { fetchImpl: impl });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts.title).toBe("Likemind ’02");
    expect(result.facts.artists).toEqual(["Nuron", "Fugue & Friends"]);
    expect(result.facts.label).toBe("Blueprint & ARchives");
  });

  it("accepts a bare SKU and queries the store API by sku", async () => {
    const { impl, calls } = fetchFromRoutes(lm02Routes());
    const result = await resolveProduct("LM-02", { fetchImpl: impl });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts.hashtag).toBe("#LM02");
    expect(calls.some((c) => c.includes("/wp-json/wc/store/v1/products?sku=LM-02"))).toBe(
      true
    );
    // Step 2 still keys on the product slug, not the SKU.
    expect(
      calls.some((c) =>
        c.includes(
          "/wp-json/wp/v2/product?slug=nuro-fugue-nuron-likemind-02-lm-02&"
        )
      )
    ).toBe(true);
  });

  it("refuses URLs outside the shop host", async () => {
    const { impl, calls } = fetchFromRoutes(lm02Routes());
    const result = await resolveProduct("https://evil.example/release/abc001/", {
      fetchImpl: impl,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PRODUCT_URL_INVALID");
    expect(calls).toEqual([]);
  });

  it("accepts the www. variant of the shop host", async () => {
    const { impl, calls } = fetchFromRoutes(lm02Routes());
    const result = await resolveProduct(
      "https://www.yoyaku.io/release/nuro-fugue-nuron-likemind-02-lm-02/",
      { fetchImpl: impl }
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.facts.hashtag).toBe("#LM02");
    expect(calls.length).toBeGreaterThan(0);
  });

  it("refuses URLs that are not release or product pages", async () => {
    const { impl } = fetchFromRoutes(lm02Routes());
    const result = await resolveProduct("https://yoyaku.io/blog/post-1/", {
      fetchImpl: impl,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PRODUCT_URL_INVALID");
  });

  it("ignores query and hash on a product URL", async () => {
    const { impl, calls } = fetchFromRoutes(lm02Routes());
    const result = await resolveProduct(`${LM02_URL}?utm_source=x#section`, {
      fetchImpl: impl,
    });

    expect(result.ok).toBe(true);
    expect(calls.some((c) => c.includes("/wp-json/wc/store/v1/products?slug="))).toBe(
      true
    );
  });

  it("returns PRODUCT_NOT_FOUND when the store API returns an empty array", async () => {
    const { impl } = fetchFromRoutes({
      "/wp-json/wc/store/v1/products?sku=NOPE-1": [],
    });
    const result = await resolveProduct("NOPE-1", { fetchImpl: impl });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PRODUCT_NOT_FOUND");
    // The Store API matches the SKU byte for byte: the error tells the user
    // to type the separators exactly as printed (LM-02, not LM02).
    expect(result.message).toContain("LM-02, not LM02");
  });

  it("maps is_on_backorder to preorder and a non-purchasable product to coming_soon", async () => {
    const preorder = fetchFromRoutes({
      "/wp-json/wc/store/v1/products?sku=PR-01": [
        { ...LM02_STORE, sku: "PR-01", is_on_backorder: true, categories: [] },
      ],
      "/wp-json/wp/v2/product?slug=nuro-fugue-nuron-likemind-02-lm-02&_fields=id,musicartist,musiclabel":
        [],
    });
    const pre = await resolveProduct("PR-01", { fetchImpl: preorder.impl });
    expect(pre.ok).toBe(true);
    if (pre.ok) expect(pre.facts.state).toBe("preorder");

    clearAssistantProductCache();
    const soon = fetchFromRoutes({
      "/wp-json/wc/store/v1/products?sku=CS-01": [
        {
          ...LM02_STORE,
          sku: "CS-01",
          is_purchasable: false,
          is_on_backorder: false,
          categories: [],
        },
      ],
      "/wp-json/wp/v2/product?slug=nuro-fugue-nuron-likemind-02-lm-02&_fields=id,musicartist,musiclabel":
        [],
    });
    const coming = await resolveProduct("CS-01", { fetchImpl: soon.impl });
    expect(coming.ok).toBe(true);
    if (coming.ok) expect(coming.facts.state).toBe("coming_soon");
  });

  it("marks a product that cannot be bought as sold_out, purchasable or not", async () => {
    // WooCommerce reports a sold-out simple product as purchasable with an
    // empty stock — the state must not read as available.
    const soldOutPurchasable = fetchFromRoutes({
      "/wp-json/wc/store/v1/products?sku=SO-01": [
        {
          ...LM02_STORE,
          sku: "SO-01",
          is_purchasable: true,
          is_in_stock: false,
          categories: [],
        },
      ],
      "/wp-json/wp/v2/product?slug=nuro-fugue-nuron-likemind-02-lm-02&_fields=id,musicartist,musiclabel":
        [],
    });
    const first = await resolveProduct("SO-01", { fetchImpl: soldOutPurchasable.impl });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.facts.state).toBe("sold_out");

    clearAssistantProductCache();
    const soldOutNotPurchasable = fetchFromRoutes({
      "/wp-json/wc/store/v1/products?sku=SO-02": [
        {
          ...LM02_STORE,
          sku: "SO-02",
          is_purchasable: false,
          is_in_stock: false,
          categories: [],
        },
      ],
      "/wp-json/wp/v2/product?slug=nuro-fugue-nuron-likemind-02-lm-02&_fields=id,musicartist,musiclabel":
        [],
    });
    const second = await resolveProduct("SO-02", {
      fetchImpl: soldOutNotPurchasable.impl,
    });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.facts.state).toBe("sold_out");

    clearAssistantProductCache();
    // Not purchasable but with stock still reads as a release not opened yet.
    const comingSoon = fetchFromRoutes({
      "/wp-json/wc/store/v1/products?sku=CS-02": [
        {
          ...LM02_STORE,
          sku: "CS-02",
          is_purchasable: false,
          is_in_stock: true,
          categories: [],
        },
      ],
      "/wp-json/wp/v2/product?slug=nuro-fugue-nuron-likemind-02-lm-02&_fields=id,musicartist,musiclabel":
        [],
    });
    const third = await resolveProduct("CS-02", { fetchImpl: comingSoon.impl });
    expect(third.ok).toBe(true);
    if (third.ok) expect(third.facts.state).toBe("coming_soon");
  });

  it("lists artist and label as missing when the taxonomy step fails", async () => {
    const { impl } = fetchFromRoutes(
      lm02Routes({
        "/wp-json/wp/v2/product?slug=nuro-fugue-nuron-likemind-02-lm-02&_fields=id,musicartist,musiclabel":
          new Error("taxonomy down"),
      })
    );
    const result = await resolveProduct(LM02_URL, { fetchImpl: impl });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts.artists).toEqual([]);
    expect(result.facts.label).toBeNull();
    expect(result.facts.missing).toEqual(["artist", "label"]);
  });

  it("lists each missing fact once when term ids are empty, and adds artist when terms resolve empty", async () => {
    // labelIds [] must not list "label" twice; a fulfilled but empty artist
    // term fetch must still count artist as missing.
    const { impl } = fetchFromRoutes({
      "/wp-json/wc/store/v1/products?sku=LM-02": [LM02_STORE],
      "/wp-json/wp/v2/product?slug=nuro-fugue-nuron-likemind-02-lm-02&_fields=id,musicartist,musiclabel":
        [{ id: 746990, musicartist: [], musiclabel: [] }],
    });
    const result = await resolveProduct("LM-02", { fetchImpl: impl });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts.missing).toEqual(["artist", "label"]);
    expect(result.facts.artists).toEqual([]);
    expect(result.facts.label).toBeNull();
  });

  it("caps the term lookup at 100 entries per page", async () => {
    const { impl, calls } = fetchFromRoutes(lm02Routes());
    await resolveProduct(LM02_URL, { fetchImpl: impl });

    expect(
      calls.some((c) =>
        c.includes(
          "/wp-json/wp/v2/musicartist?include=28126,28180&per_page=100&_fields=id,name"
        )
      )
    ).toBe(true);
  });

  it("lists catalogue_ref as missing when the SKU is not a valid reference", async () => {
    const { impl } = fetchFromRoutes({
      "/wp-json/wc/store/v1/products?sku=TEESHIRT": [
        { ...LM02_STORE, sku: "TEESHIRT", slug: "tee-shirt" },
      ],
      "/wp-json/wp/v2/product?slug=tee-shirt&_fields=id,musicartist,musiclabel":
        [],
    });
    const result = await resolveProduct("TEESHIRT", { fetchImpl: impl });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts.catnoTag).toBeNull();
    expect(result.facts.hashtag).toBeNull();
    expect(result.facts.missing).toContain("catalogue_ref");
  });

  it("returns SHOP_UNAVAILABLE when the store API is unreachable", async () => {
    const { impl } = fetchFromRoutes({
      "/wp-json/wc/store/v1/products?sku=LM-02": new Error("network down"),
    });
    const result = await resolveProduct("LM-02", { fetchImpl: impl });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("SHOP_UNAVAILABLE");
  });

  it("refuses a comma in a bare SKU", async () => {
    const { impl, calls } = fetchFromRoutes(lm02Routes());
    const result = await resolveProduct("LM-02,XX-01", { fetchImpl: impl });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PRODUCT_URL_INVALID");
    expect(calls).toEqual([]);
  });

  it("refuses the first store row when it is not the requested product", async () => {
    // If a plugin change made the store filter a no-op, the first row of the
    // whole catalogue must not become the campaign.
    const { impl } = fetchFromRoutes({
      "/wp-json/wc/store/v1/products?sku=LM-02": [
        { ...LM02_STORE, sku: "OTHER-01", slug: "other-release" },
      ],
    });
    const result = await resolveProduct("LM-02", { fetchImpl: impl });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PRODUCT_NOT_FOUND");
  });

  it("memoizes a resolved product for repeated inputs", async () => {
    const { impl, calls } = fetchFromRoutes(lm02Routes());
    const first = await resolveProduct(LM02_URL, { fetchImpl: impl });
    const second = await resolveProduct(LM02_URL, { fetchImpl: impl });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const storeCalls = calls.filter((c) =>
      c.includes("/wp-json/wc/store/v1/products")
    );
    expect(storeCalls).toHaveLength(1);
  });
});

afterEach(() => {
  clearAssistantProductCache();
});
