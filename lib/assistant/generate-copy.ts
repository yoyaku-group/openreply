import type { LintResult } from "@/lib/copy/copy-linter";
import { lintCampaignCopy } from "@/lib/copy/copy-linter";
import { missingFacts } from "@/lib/copy/release-facts";
import type { ReleaseFacts } from "@/lib/copy/release-facts";
import { buildCampaignCopy } from "@/lib/copy/yoyaku-patterns";
import type { CampaignCopy } from "@/lib/copy/yoyaku-patterns";
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

  const copy = buildCampaignCopy(releaseFacts);
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
