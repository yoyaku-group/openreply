/**
 * UTM tags for DM-tracked destinations (automation playbook, house style
 * item 4): every `TrackedLink` destination carries
 * `utm_source=instagram&utm_medium=dm&utm_campaign=<campaign>` so the shop
 * side can attribute DM traffic. Parameters the destination URL already sets
 * are never overwritten, and the rest of the query string and the hash are
 * preserved.
 */

const DM_UTM_PARAMS: ReadonlyArray<readonly [string, string]> = [
  ["utm_source", "instagram"],
  ["utm_medium", "dm"],
];

/** Lower-case slug: every run of characters outside `[a-z0-9]` becomes one `-`. */
function dmUtmCampaignSlug(campaign: string): string {
  // A campaign made of nothing but separators carries no usable slug.
  if (!/[a-z0-9]/.test(campaign.toLowerCase())) return "";
  return campaign.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

/** `utm_content` value that ties one click back to the exact DM that carried it. */
export function dmUtmContent(dmLogId: string): string {
  return `dm-${dmLogId}`;
}

/**
 * Tag a destination with the DM that delivered it (`utm_content=dm-<id>`), so a
 * landing page or shop order can be reconciled to a single DM and therefore to
 * the ad that produced the comment. An existing `utm_content` always wins: the
 * shop side may already use it for its own segmentation.
 */
export function withDmContentUtm(url: string, dmLogId: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (!parsed.searchParams.has("utm_content")) {
    parsed.searchParams.set("utm_content", dmUtmContent(dmLogId));
  }
  return parsed.toString();
}

/**
 * Append the DM UTM parameters to a destination URL. An unparsable URL is
 * returned unchanged rather than losing the destination.
 */
export function withDmUtm(url: string, campaign: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  for (const [key, value] of DM_UTM_PARAMS) {
    if (!parsed.searchParams.has(key)) {
      parsed.searchParams.set(key, value);
    }
  }
  const campaignSlug = dmUtmCampaignSlug(campaign);
  if (campaignSlug && !parsed.searchParams.has("utm_campaign")) {
    parsed.searchParams.set("utm_campaign", campaignSlug);
  }
  return parsed.toString();
}
