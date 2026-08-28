import type { InstagramMedia } from "@/lib/meta/client";
import { captionMatchesCatno } from "@/lib/release-sync/shop-feed";

/**
 * Select the only media an automation is allowed to bind to.
 *
 * SKU-tagged automations fail closed: a missing #SKU match must never fall
 * through to an unrelated reel. Legacy "next reel" behavior is retained only
 * for automations that were intentionally created without a catalogue number.
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

  return eligible.find((item) => item.media_product_type === "REELS");
}
