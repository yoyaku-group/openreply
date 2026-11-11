import type { LintResult } from "@/lib/copy/copy-linter";
import { lintCampaignCopy } from "@/lib/copy/copy-linter";
import { missingFacts } from "@/lib/copy/release-facts";
import type { ReleaseFacts } from "@/lib/copy/release-facts";
import { buildCampaignCopy } from "@/lib/copy/yoyaku-patterns";
import type { CampaignCopy } from "@/lib/copy/yoyaku-patterns";
import { META_BUTTON_LIMIT } from "@/lib/copy/yoyaku-patterns";
import type { ProductFacts } from "@/lib/assistant/resolve-product";

/**
 * The assistant's copy step: ONE replaceable function.
 *
 * This lot is deterministic — copy is poured into the hand-written YOYAKU
 * shells of `buildCampaignCopy`. A later lot swaps this implementation for an
 * LLM one (which is why the caption is already a parameter); nothing else in
 * the assistant is allowed to know how the copy was made.
 *
 * Facts are never filled in: a missing artist, label, title, SKU or link
 * fails the step with MISSING_FACTS instead of producing invented copy.
 */

export interface GeneratedCopy {
  ok: true;
  provenance: "standard";
  openingDm: string;
  openingButton: string;
  revealDm: string;
  linkButton: string;
  /** The full shell output (name, destination, secondary button), for the payload. */
  copy: CampaignCopy;
  /** Lint of the generated copy against the release facts. */
  lint: LintResult;
}

export interface MissingFactsError {
  ok: false;
  error: "MISSING_FACTS";
  missing: string[];
}

export type GenerateCopyResult = GeneratedCopy | MissingFactsError;

/** Map a product state onto the release event type the shells understand. */
export function releaseEventTypeFor(
  state: ProductFacts["state"],
): ReleaseFacts["eventType"] {
  if (state === "preorder") return "preorder_open";
  if (state === "restock") return "restock";
  return "release_live";
}

/** Map resolved product facts onto the fact block the copy shells take. */
export function releaseFactsFrom(facts: ProductFacts): ReleaseFacts {
  return {
    eventType: releaseEventTypeFor(facts.state),
    artist: facts.artists.join(" & "),
    title: facts.title,
    catno: facts.sku,
    label: facts.label ?? "",
    url: facts.permalink,
  };
}

/**
 * States with nothing to buy yet. The shared shells all claim availability
 * ("out now", "in the shop", "back in stock", "preorder is open") — pouring
 * them into a coming-soon or sold-out product would lie to every commenter,
 * so these two states get their own truthful openings. Campaigns for these
 * states are drafts only; the shells are replaced when the product becomes
 * buyable and the campaign is validated.
 */
function unavailableStateCopy(
  facts: ProductFacts,
  releaseFacts: ReleaseFacts,
): { copy: CampaignCopy; state: ProductFacts["state"] } | null {
  if (facts.state !== "coming_soon" && facts.state !== "sold_out") return null;

  const artist = releaseFacts.artist;
  const opening =
    facts.state === "coming_soon"
      ? `${artist}, ${facts.title} is coming soon to the shop.`
      : `${artist}, ${facts.title} is sold out for now.`;

  const copy: CampaignCopy = {
    name: `${facts.sku} ${facts.state === "coming_soon" ? "Coming soon" : "Sold out"}`,
    goal: facts.state === "coming_soon" ? "Coming soon link" : "Sold out link",
    openingDmMessage: opening,
    openingDmButtonLabel: "Send the link",
    dmMessage: "Here you go:",
    linkButtonLabel: facts.sku.slice(0, META_BUTTON_LIMIT),
    trackedDestinationUrl: facts.permalink,
  };
  return { copy, state: facts.state };
}

/**
 * Generate the four DM strings from product facts. `caption` is accepted for
 * the future LLM implementation; the deterministic shells read the product
 * description only, so it is deliberately unused here.
 */
export function generateCopy(
  facts: ProductFacts,
  caption?: string | null,
): GenerateCopyResult {
  void caption;

  const releaseFacts = releaseFactsFrom(facts);
  const missing = missingFacts(releaseFacts);
  if (missing.length > 0) {
    return { ok: false, error: "MISSING_FACTS", missing };
  }

  // Nothing to buy yet: truthful openings instead of availability claims.
  const unavailable = unavailableStateCopy(facts, releaseFacts);
  const copy = unavailable
    ? unavailable.copy
    : buildCampaignCopy(releaseFacts);
  const lint = lintCampaignCopy(copy, releaseFacts);

  return {
    ok: true,
    provenance: "standard",
    openingDm: copy.openingDmMessage,
    openingButton: copy.openingDmButtonLabel,
    revealDm: copy.dmMessage,
    linkButton: copy.linkButtonLabel,
    copy,
    lint,
  };
}
