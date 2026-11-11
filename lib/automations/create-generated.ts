/**
 * Creates a campaign from generated YOYAKU copy.
 *
 * Deliberately narrower than the interactive POST /api/automations route:
 * generated campaigns are born INACTIVE (a human reviews and activates during
 * the trial period), pending a post, and carry the catno so the attach cron
 * can bind them to the exact media whose caption contains #<catno>.
 */

import { prisma } from "@/lib/db/client";
import { generateTrackedLinkSlug } from "@/lib/tracking/server";
import { withDmUtm } from "@/lib/tracking/utm";
import { generateReportShareSlug } from "@/lib/reports/share";
import { normalizeCatnoTag, parseCatnoTag } from "@/lib/automations/catalogue";
import type { CampaignCopy } from "@/lib/copy/yoyaku-patterns";

export interface GeneratedCampaignInput {
  copy: CampaignCopy;
  /** Catalogue number used for #catno post binding; null for instore. */
  catnoTag: string | null;
  workspaceId: string;
  instagramAccountId: string;
  isActive: boolean;
}

/**
 * Returns the created automation, or null when the catalogue reference is
 * unusable (the release-sync cron records the skip outcome itself). The
 * ReleaseSyncEvent row keeps the raw SKU: a SKU is a shop identifier, the
 * campaign carries only its normalized catalogue form.
 */
export async function createGeneratedCampaign(input: GeneratedCampaignInput) {
  const { copy, workspaceId } = input;

  const catnoTag = normalizeCatnoTag(input.catnoTag);
  if (catnoTag) {
    const parsed = parseCatnoTag(catnoTag);
    if (!parsed.ok) {
      console.warn(
        "[create-generated] skip_invalid_catalogue_reference",
        JSON.stringify({ sku: input.catnoTag, reason: parsed.message }),
      );
      return null;
    }
  }

  // The tracked link's utm_campaign: the lower-case reference when there is
  // one, otherwise a slug of the campaign name (withDmUtm slugifies it).
  const dmUtmCampaign = catnoTag ?? copy.name;

  const linkCreates = [
    {
      workspaceId,
      slug: generateTrackedLinkSlug(),
      label: "Primary campaign link",
      destinationUrl: withDmUtm(copy.trackedDestinationUrl, dmUtmCampaign),
    },
  ];
  if (copy.secondaryDestinationUrl) {
    linkCreates.push({
      workspaceId,
      slug: generateTrackedLinkSlug(),
      label: copy.secondaryButtonLabel ?? "Open link",
      destinationUrl: withDmUtm(copy.secondaryDestinationUrl, dmUtmCampaign),
    });
  }

  return prisma.automation.create({
    data: {
      name: copy.name,
      goal: copy.goal,
      postId: null,
      postUrl: null,
      pendingNextReel: true,
      catnoTag,
      matchAnyPost: false,
      keywords: [],
      matchAnyWord: true,
      dmMessage: copy.dmMessage,
      openingDmEnabled: true,
      openingDmMessage: copy.openingDmMessage,
      openingDmButtonLabel: copy.openingDmButtonLabel,
      linkButtonLabel: copy.linkButtonLabel,
      isActive: input.isActive,
      wholeWordMatch: true,
      workspaceId,
      instagramAccountId: input.instagramAccountId,
      reportShareSlug: generateReportShareSlug(),
      trackedLinks: { create: linkCreates },
    },
    include: { trackedLinks: true },
  });
}
