import { displayCatnoTag } from "@/lib/automations/catalogue";

export type CampaignStatusKey =
  | "draft"
  | "waiting"
  | "active"
  | "paused"
  | "needs_attention";

export interface CampaignStatus {
  key: CampaignStatusKey;
  label: string;
}

export interface CampaignStatusInput {
  isActive: boolean;
  pendingNextReel?: boolean | null;
  postId?: string | null;
  catnoTag?: string | null;
  lifecycle?: string | null;
  source?: string | null;
}

/**
 * One status vocabulary for the list, detail and builder views.
 * - Draft: not approved/armed yet (or a Calendar draft awaiting review).
 * - Waiting for #ABC001: approved, armed, not bound to its publication yet.
 * - Active: sending on its bound target.
 * - Paused: explicitly stopped.
 * - Needs attention: the binder found a Calendar conflict or another
 *   non-sendable state that needs a human decision.
 */
export function campaignStatus(campaign: CampaignStatusInput): CampaignStatus {
  if (campaign.lifecycle === "NEEDS_ATTENTION") {
    return { key: "needs_attention", label: "Needs attention" };
  }
  if (campaign.isActive) {
    const tag = displayCatnoTag(campaign.catnoTag);
    return campaign.pendingNextReel && tag
      ? { key: "waiting", label: `Waiting for ${tag}` }
      : { key: "active", label: "Active" };
  }
  if (
    (campaign.source === "CALENDAR" &&
      (campaign.lifecycle === "PLANNED" || campaign.lifecycle === "READY")) ||
    (campaign.pendingNextReel && !campaign.postId)
  ) {
    return { key: "draft", label: "Draft" };
  }
  return { key: "paused", label: "Paused" };
}

export function campaignStatusClass(key: CampaignStatusKey): string {
  switch (key) {
    case "active":
      return "bg-success/10 text-success";
    case "waiting":
      return "bg-amber-500/10 text-amber-400";
    case "needs_attention":
      return "bg-error/10 text-error";
    case "draft":
      return "bg-accent/10 text-accent";
    case "paused":
    default:
      return "bg-zinc-500/10 text-zinc-400";
  }
}
