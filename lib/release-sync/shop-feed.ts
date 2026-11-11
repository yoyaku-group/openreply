/**
 * Contract with the shop's release feed (yoyaku.io theme,
 * GET /yoyaku/v1/release-events) and the pure derivation of typed events
 * from stateless snapshots.
 *
 * The feed reports the CURRENT state of recent exclusive products; this
 * module diffs it against the last state stored per SKU to derive the four
 * events the pipeline reacts to. Keeping the derivation pure makes it
 * testable without a database or network.
 */

import type { CampaignFacts } from "@/lib/copy/release-facts";
import { captionHasCatnoTag } from "@/lib/automations/catalogue";

export interface ShopProduct {
  sku: string;
  artist: string;
  label: string;
  title: string;
  url: string;
  stock_status: "onbackorder" | "instock" | "outofstock";
  is_preorder: boolean;
  published_gmt: string;
}

export interface ShopInstoreSession {
  artist: string;
  youtube_url: string;
  soundcloud_url: string;
  published_gmt: string;
}

export interface ShopFeed {
  products: ShopProduct[];
  instore: ShopInstoreSession[];
}

export interface DerivedEvent {
  /** Dedup key — the SKU for releases, a slug of the artist for instore. */
  sku: string;
  facts: CampaignFacts;
}

function releaseFacts(
  product: ShopProduct,
  eventType: "preorder_open" | "release_live" | "restock"
): CampaignFacts {
  return {
    eventType,
    artist: product.artist,
    title: product.title,
    catno: product.sku,
    label: product.label,
    url: product.url,
  };
}

/**
 * State transitions:
 * - unseen + onbackorder            -> preorder_open
 * - unseen + instock                -> release_live (exclusive that skipped preorder)
 * - onbackorder -> instock          -> release_live
 * - outofstock -> instock           -> restock
 * Anything else (unchanged status, going out of stock) derives nothing.
 */
export function deriveReleaseEvents(
  products: ShopProduct[],
  lastStatusBySku: Map<string, string>
): DerivedEvent[] {
  const events: DerivedEvent[] = [];

  for (const product of products) {
    const previous = lastStatusBySku.get(product.sku);
    const current = product.stock_status;

    if (previous === current) continue;

    if (current === "onbackorder" && previous === undefined) {
      events.push({ sku: product.sku, facts: releaseFacts(product, "preorder_open") });
    } else if (current === "instock") {
      if (previous === "outofstock") {
        events.push({ sku: product.sku, facts: releaseFacts(product, "restock") });
      } else {
        // undefined or onbackorder
        events.push({ sku: product.sku, facts: releaseFacts(product, "release_live") });
      }
    }
  }

  return events;
}

export function instoreDedupKey(artist: string): string {
  return `instore:${artist.trim().toLowerCase().replace(/\s+/g, "-")}`;
}

export function deriveInstoreEvents(sessions: ShopInstoreSession[]): DerivedEvent[] {
  return sessions.map((session) => ({
    sku: instoreDedupKey(session.artist),
    facts: {
      eventType: "instore_published",
      artist: session.artist,
      youtubeUrl: session.youtube_url,
      soundcloudUrl: session.soundcloud_url || "https://soundcloud.com/yoyaku",
    },
  }));
}

/**
 * Whole-token equality on the normalized reference (`captionHasCatnoTag`):
 * `#LM-02`, `#lm02`, `#LM_02` and `#LM02` all match the stored tag `LM02`
 * (and its legacy `LM-02` form), while `#LM02X` does not match `LM02`. A
 * reference without a digit is never valid, so a bare `#LM` matches nothing.
 */
export function captionMatchesCatno(
  caption: string | undefined,
  catno: string
): boolean {
  if (!caption) return false;
  // Callers normally pass the canonical bare token, but legacy Calendar rows
  // have stored a leading `#`; `captionHasCatnoTag` normalizes either form.
  return captionHasCatnoTag(caption, catno);
}
