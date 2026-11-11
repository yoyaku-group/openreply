import { parseCatnoTag } from "@/lib/automations/catalogue";

/**
 * Product resolver for the campaign assistant.
 *
 * Public shop data only, no token: the WooCommerce Store API and the WordPress
 * REST taxonomy endpoints are anonymous. The base URL comes from
 * `ASSISTANT_SHOP_BASE_URL` (default https://yoyaku.io) and only URLs on that
 * host are accepted, so a pasted link can never point the resolver somewhere
 * else.
 *
 * Never invents a value: a failed taxonomy lookup lands in `facts.missing`
 * and the copy step refuses to fill it in. Results are memoized for 5 minutes
 * per slug or SKU because preparing a campaign re-reads the same product.
 */

const DEFAULT_BASE_URL = "https://yoyaku.io";
const FETCH_TIMEOUT_MS = 5000;
const MEMO_TTL_MS = 5 * 60 * 1000;
const DESCRIPTION_MAX_LENGTH = 1200;

export type ProductState =
  | "preorder"
  | "coming_soon"
  | "restock"
  | "available";

export interface ProductFacts {
  /** WooCommerce product id, null when the store API returned no id. */
  productId: number | null;
  sku: string;
  /** Canonical catalogue reference (`LM-02` stores as `LM02`), null when the SKU is not a valid reference. */
  catnoTag: string | null;
  /** Published hashtag form (`#LM02`), null when the SKU is not a valid reference. */
  hashtag: string | null;
  title: string;
  artists: string[];
  label: string | null;
  permalink: string;
  imageUrl: string | null;
  /** Plain-text product description, capped at 1200 characters. */
  description: string;
  state: ProductState;
  /** Names of the facts that could not be read: `artist`, `label`, `catalogue_ref`. */
  missing: string[];
}

export type ResolveProductErrorCode =
  | "PRODUCT_URL_INVALID"
  | "PRODUCT_NOT_FOUND"
  | "SHOP_UNAVAILABLE";

export type ResolveProductResult =
  | { ok: true; facts: ProductFacts }
  | { ok: false; code: ResolveProductErrorCode; message: string };

export interface ResolveProductOptions {
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable clock for the memo cache. */
  now?: () => number;
}

interface StoreApiProduct {
  id?: number;
  name?: string;
  sku?: string;
  slug?: string;
  permalink?: string;
  images?: { src?: string }[];
  short_description?: string;
  description?: string;
  is_purchasable?: boolean;
  is_in_stock?: boolean;
  is_on_backorder?: boolean;
  categories?: { name?: string }[];
}

interface ProductTermRow {
  id?: number;
  musicartist?: number[];
  musiclabel?: number[];
}

interface TermRow {
  id?: number;
  name?: string;
}

/* ------------------------------ memo cache ------------------------------ */

interface MemoEntry {
  facts: ProductFacts;
  at: number;
}

const memo = new Map<string, MemoEntry>();

/** The memo holds successes only; cap it so a worker cannot grow it forever. */
const MEMO_MAX_ENTRIES = 200;

function pruneMemo(nowMs: number): void {
  for (const [key, entry] of memo) {
    if (nowMs - entry.at >= MEMO_TTL_MS) memo.delete(key);
  }
  // Still oversized (a burst of distinct products inside the TTL): drop the
  // oldest entries; Map iterates in insertion order.
  while (memo.size > MEMO_MAX_ENTRIES) {
    const oldest = memo.keys().next().value;
    if (oldest === undefined) break;
    memo.delete(oldest);
  }
}

/** Clears the resolver memo (tests and long-lived workers). */
export function clearAssistantProductCache(): void {
  memo.clear();
}

/* --------------------------- input parsing ------------------------------ */

function shopBaseUrl(): URL {
  const raw = process.env.ASSISTANT_SHOP_BASE_URL?.trim() || DEFAULT_BASE_URL;
  try {
    return new URL(raw);
  } catch {
    return new URL(DEFAULT_BASE_URL);
  }
}

type ParsedInput =
  | { kind: "slug"; slug: string }
  | { kind: "sku"; sku: string };

function parseProductInput(
  input: string,
  base: URL,
): { ok: true; parsed: ParsedInput } | { ok: false; code: ResolveProductErrorCode; message: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    return {
      ok: false,
      code: "PRODUCT_URL_INVALID",
      message: "Enter a product URL or a SKU.",
    };
  }

  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return {
        ok: false,
        code: "PRODUCT_URL_INVALID",
        message: "This is not a valid product URL.",
      };
    }
    // Only the configured shop host is accepted; query and hash are ignored.
    if (url.host.toLowerCase() !== base.host.toLowerCase()) {
      return {
        ok: false,
        code: "PRODUCT_URL_INVALID",
        message: `Only product URLs on ${base.host} are accepted.`,
      };
    }
    const match = url.pathname.match(/^\/(?:release|product)\/([^/]+)\/?$/);
    if (!match) {
      return {
        ok: false,
        code: "PRODUCT_URL_INVALID",
        message:
          "Enter a product URL like https://yoyaku.io/release/<slug>/ or a SKU.",
      };
    }
    let slug = match[1];
    try {
      slug = decodeURIComponent(slug);
    } catch {
      // A malformed escape stays a malformed slug; the API lookup will miss.
    }
    return { ok: true, parsed: { kind: "slug", slug } };
  }

  // Everything else is a bare SKU.
  if (/\s/.test(trimmed) || trimmed.length > 100) {
    return {
      ok: false,
      code: "PRODUCT_URL_INVALID",
      message: "Enter a product URL like https://yoyaku.io/release/<slug>/ or a SKU.",
    };
  }
  return { ok: true, parsed: { kind: "sku", sku: trimmed } };
}

/* ------------------------- description cleaning -------------------------- */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  middot: "·",
  times: "×",
  euro: "€",
  pound: "£",
  yen: "¥",
  deg: "°",
};

/** Decode numeric (`&#8217;`) and common named HTML entities. */
function decodeEntities(text: string): string {
  // Out-of-range code points decode to nothing; String.fromCodePoint would
  // throw a RangeError above 0x10FFFF and fail the whole product read.
  const safeChar = (code: number) =>
    Number.isFinite(code) && code >= 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : "";
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      safeChar(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d{1,7});/g, (_, dec: string) =>
      safeChar(Number.parseInt(dec, 10)),
    )
    .replace(/&([a-z]+);/gi, (entity, name: string) =>
      NAMED_ENTITIES[name.toLowerCase()] ?? entity,
    );
}

/** Strip HTML, decode entities, drop UI chrome, collapse whitespace. */
export function cleanProductDescription(raw: string | null | undefined): string {
  if (!raw) return "";
  const text = decodeEntities(raw.replace(/<[^>]*>/g, " "))
    // Trailing WooCommerce UI text, never product copy.
    .replace(/add to wishlist/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > DESCRIPTION_MAX_LENGTH
    ? `${text.slice(0, DESCRIPTION_MAX_LENGTH - 1).trimEnd()}…`
    : text;
}

/* ------------------------------- resolver -------------------------------- */

class TransportError extends Error {}

class ProductNotFoundError extends Error {}

async function fetchJson<T>(
  url: string,
  fetchImpl: typeof fetch,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new TransportError(`Shop returned HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof TransportError) throw error;
    throw new TransportError("Shop request failed", { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

function readState(product: StoreApiProduct): ProductState {
  if (product.is_on_backorder === true) return "preorder";
  if (product.is_purchasable === false) return "coming_soon";
  if (
    (product.categories ?? []).some(
      (category) => category.name?.trim().toLowerCase() === "back in stock",
    )
  ) {
    return "restock";
  }
  return "available";
}

async function resolveTaxonomy(
  base: URL,
  slug: string,
  fetchImpl: typeof fetch,
): Promise<{ artists: string[]; label: string | null; missing: string[] }> {
  const missing = new Set<string>();
  try {
    const rows = await fetchJson<ProductTermRow[]>(
      `${base.origin}/wp-json/wp/v2/product?slug=${encodeURIComponent(slug)}&_fields=id,musicartist,musiclabel`,
      fetchImpl,
    );
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row) {
      return { artists: [], label: null, missing: ["artist", "label"] };
    }

    const artistIds = row.musicartist ?? [];
    const labelIds = row.musiclabel ?? [];

    const [artistTerms, labelTerms] = await Promise.allSettled([
      artistIds.length
        ? fetchJson<TermRow[]>(
            // per_page: compilations can carry more artists than the default 10.
            `${base.origin}/wp-json/wp/v2/musicartist?include=${artistIds.join(",")}&per_page=100&_fields=id,name`,
            fetchImpl,
          )
        : Promise.resolve<TermRow[]>([]),
      labelIds.length
        ? fetchJson<TermRow[]>(
            `${base.origin}/wp-json/wp/v2/musiclabel?include=${labelIds.join(",")}&per_page=100&_fields=id,name`,
            fetchImpl,
          )
        : Promise.resolve<TermRow[]>([]),
    ]);

    // An empty term list is a missing fact, not an empty fact: the copy step
    // refuses to fill it in.
    if (artistIds.length === 0) missing.add("artist");
    if (labelIds.length === 0) missing.add("label");

    // Artist order follows step 2's id list, not the term endpoint's order.
    const artists: string[] = [];
    if (artistTerms.status === "fulfilled") {
      const names = new Map(
        artistTerms.value.map((term) => [term.id, term.name ?? ""]),
      );
      for (const id of artistIds) {
        const name = names.get(id)?.trim();
        if (name) artists.push(name);
      }
    } else {
      missing.add("artist");
    }
    // Resolved-but-empty (private term, blank name, id mismatch) is missing
    // too, otherwise the copy step would see a complete empty artist list.
    if (artists.length === 0) missing.add("artist");

    let label: string | null = null;
    if (labelTerms.status === "fulfilled") {
      const names = new Map(
        labelTerms.value.map((term) => [term.id, term.name ?? ""]),
      );
      for (const id of labelIds) {
        const name = names.get(id)?.trim();
        if (name) {
          label = name;
          break;
        }
      }
    }
    if (!label) missing.add("label");

    return { artists, label, missing: [...missing] };
  } catch (error) {
    // A failed taxonomy read degrades the facts; it never fails the product.
    // The cause is logged: a silent taxonomy regression would drain artist and
    // label out of every prepared campaign without a trace.
    console.error("[assistant] product taxonomy read failed", slug, error);
    return { artists: [], label: null, missing: ["artist", "label"] };
  }
}

async function resolveProductFacts(
  base: URL,
  query: string,
  fallbackSku: string,
  fetchImpl: typeof fetch,
): Promise<ProductFacts> {
  const products = await fetchJson<StoreApiProduct[]>(
    `${base.origin}/wp-json/wc/store/v1/products?${query}`,
    fetchImpl,
  );
  const product = Array.isArray(products) ? products[0] : undefined;
  if (!product) {
    throw new ProductNotFoundError("No product matched this URL or SKU.");
  }

  const slug = product.slug?.trim() || "";
  const sku = product.sku?.trim() || fallbackSku;
  const { artists, label, missing } = slug
    ? await resolveTaxonomy(base, slug, fetchImpl)
    : { artists: [], label: null, missing: ["artist", "label"] };

  const parsedTag = parseCatnoTag(sku);
  if (!parsedTag.ok) missing.push("catalogue_ref");

  const catnoTag = parsedTag.ok ? parsedTag.value : null;

  return {
    productId: typeof product.id === "number" ? product.id : null,
    sku,
    catnoTag,
    hashtag: catnoTag ? `#${catnoTag}` : null,
    title: product.name?.trim() || "",
    artists,
    label,
    permalink: product.permalink?.trim() || "",
    imageUrl: product.images?.[0]?.src?.trim() || null,
    description: cleanProductDescription(
      product.short_description?.trim()
        ? product.short_description
        : product.description,
    ),
    state: readState(product),
    missing,
  };
}

/**
 * Resolve a product URL (`/release/<slug>/`, `/product/<slug>/`) or a bare
 * SKU into campaign-ready facts.
 */
export async function resolveProduct(
  input: string,
  options: ResolveProductOptions = {},
): Promise<ResolveProductResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const base = shopBaseUrl();

  const parsed = parseProductInput(input, base);
  if (!parsed.ok) return parsed;

  const memoKey = `${base.origin}|${
    parsed.parsed.kind === "slug"
      ? `slug:${parsed.parsed.slug}`
      : `sku:${parsed.parsed.sku}`
  }`;
  const cached = memo.get(memoKey);
  if (cached && now() - cached.at < MEMO_TTL_MS) {
    return { ok: true, facts: cached.facts };
  }

  try {
    const facts = await resolveProductFacts(
      base,
      parsed.parsed.kind === "slug"
        ? `slug=${encodeURIComponent(parsed.parsed.slug)}`
        : `sku=${encodeURIComponent(parsed.parsed.sku)}`,
      parsed.parsed.kind === "sku" ? parsed.parsed.sku : "",
      fetchImpl,
    );
    memo.set(memoKey, { facts, at: now() });
    if (memo.size > MEMO_MAX_ENTRIES) pruneMemo(now());
    return { ok: true, facts };
  } catch (error) {
    // Transport failures are not memoized (a transient outage should retry on
    // the next click); the cause is logged before the stable error code.
    console.error("[assistant] product read failed", memoKey, error);
    if (error instanceof ProductNotFoundError) {
      return {
        ok: false,
        code: "PRODUCT_NOT_FOUND",
        message: "No product on the shop matches this URL or SKU.",
      };
    }
    return {
      ok: false,
      code: "SHOP_UNAVAILABLE",
      message: "The shop did not answer. Try again in a moment.",
    };
  }
}
