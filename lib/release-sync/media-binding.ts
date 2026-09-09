import type { InstagramMedia } from "@/lib/meta/client";
import { captionMatchesCatno } from "@/lib/release-sync/shop-feed";

/**
 * Select the only media an automation is allowed to bind to.
 *
 * SKU-tagged automations fail closed: a missing #SKU match must never fall
 * through to an unrelated post. Legacy "next post or reel" behavior is
 * retained only for automations that were intentionally created without a
 * catalogue number.
 */
export function selectMediaForPendingAutomation(
  media: InstagramMedia[],
  createdAt: Date,
  catnoTag: string | null
): InstagramMedia | undefined {
  const eligible = media
    .filter((item) => new Date(item.timestamp) > createdAt)
    .sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

  if (catnoTag) {
    return eligible.find((item) =>
      captionMatchesCatno(item.caption, catnoTag)
    );
  }

  // The campaign builder promises the next post or reel. Meta labels feed
  // posts as FEED and reels as REELS; ignore other media products (for example
  // stories) so a pending campaign cannot bind to the wrong surface.
  return eligible.find(
    (item) =>
      item.media_product_type === "FEED" ||
      item.media_product_type === "REELS"
  );
}
