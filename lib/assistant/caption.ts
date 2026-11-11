import { extractCaptionCatnoTags } from "@/lib/automations/catalogue";
import type { ProductFacts } from "@/lib/assistant/resolve-product";

/**
 * Caption composition for the campaign assistant.
 *
 * The caption is OPTIONAL: a simple product works with no caption at all,
 * because the copy comes from the product description. When a caption is
 * pasted it is checked and completed, never rewritten — the CTA and the
 * catalogue hashtag are appended as whole lines, everything else stays.
 *
 * The module is pure so the review screen can re-run it client-side when the
 * "When" choice changes.
 */

export type CheckLevel = "ok" | "warn" | "error";

export interface Check {
  level: CheckLevel;
  /** Stable machine code, shared with the docs (`docs/campaign-assistant.md`). */
  code: string;
  message: string;
}

export interface ComposeCaptionInput {
  caption?: string | null;
  facts: ProductFacts;
  cta: string;
  /**
   * The post is already published (specific-post scope): nothing can be added
   * for the hashtag, and warnings about a pasted caption are only useful when
   * a caption was actually pasted.
   */
  alreadyPublished?: boolean;
}

export interface ComposeCaptionResult {
  /** The completed caption, or null when no caption was given. */
  final: string | null;
  /** Lines to add to the user's caption, in order (CTA first, hashtag last). */
  additions: string[];
  checks: Check[];
}

/** A price: a currency sign or code next to digits (€220, 220 €, EUR, $, £). */
const PRICE_PATTERN =
  /(?:[$€£¥]\s*\d)|(?:\d\s*[$€£¥])|(?:\b(?:EUR|USD|GBP|CHF)\s*\d)|(?:\d\s*(?:EUR|USD|GBP|CHF)\b)/i;

const URL_PATTERN = /(?:https?:\/\/|www\.)\S+/i;

/** Instagram counts every #token; the playbook allows five. */
const MAX_HASHTAGS = 5;

/** Meta/Instagram caption hard limit; anything longer is truncated on post. */
const MAX_CAPTION_LENGTH = 2200;

function captionLinesIncludeCta(caption: string, cta: string): boolean {
  const wanted = cta.trim().toLowerCase();
  if (!wanted) return true;
  return caption
    .split(/\r?\n/)
    .some((line) => line.trim().toLowerCase() === wanted);
}

/**
 * Compose the caption for a prepared product: check the catalogue reference
 * and the CTA, warn about prices, URLs, hashtag count and length, and return
 * the lines to add when something is missing.
 */
export function composeCaption(input: ComposeCaptionInput): ComposeCaptionResult {
  const { facts, cta, alreadyPublished = false } = input;
  const caption = input.caption?.trim() ? input.caption.trim() : "";
  const checks: Check[] = [];
  const additions: string[] = [];

  if (caption) {
    const refs = extractCaptionCatnoTags(caption);
    if (refs.length === 0) {
      if (!alreadyPublished && facts.hashtag) {
        checks.push({
          level: "warn",
          code: "REFERENCE_MISSING",
          message: `The caption does not carry ${facts.hashtag}. It is added below.`,
        });
        additions.push(facts.hashtag);
      }
    } else if (!refs.includes(facts.catnoTag ?? "")) {
      checks.push({
        level: "error",
        code: "OTHER_REFERENCE",
        message:
          "The caption carries a different catalogue reference. Two references send two messages.",
      });
    } else if (refs.length > 1) {
      checks.push({
        level: "error",
        code: "OTHER_REFERENCE",
        message:
          "The caption carries more than one catalogue reference. Two references send two messages.",
      });
    } else {
      checks.push({
        level: "ok",
        code: "REFERENCE_PRESENT",
        message: `${facts.hashtag} is in the caption.`,
      });
    }

    if (captionLinesIncludeCta(caption, cta)) {
      checks.push({
        level: "ok",
        code: "CTA_PRESENT",
        message: `The call to action is already in the caption.`,
      });
    } else {
      checks.push({
        level: "warn",
        code: "CTA_MISSING",
        message: "The call to action is missing. It is added below.",
      });
      additions.unshift(cta);
    }

    // Paste-only warnings: without a pasted caption there is nothing to read.
    if (PRICE_PATTERN.test(caption)) {
      checks.push({
        level: "warn",
        code: "PRICE_IN_CAPTION",
        message:
          "The caption mentions a price. Prices change and the DM carries the link.",
      });
    }
    if (URL_PATTERN.test(caption)) {
      checks.push({
        level: "warn",
        code: "URL_IN_CAPTION",
        message:
          "The caption carries a URL. The DM link is tracked, a caption link is not.",
      });
    }
    const hashtagCount = (caption.match(/#[^\s#]+/g) ?? []).length;
    if (hashtagCount > MAX_HASHTAGS) {
      checks.push({
        level: "warn",
        code: "TOO_MANY_HASHTAGS",
        message: `The caption carries ${hashtagCount} hashtags. Keep it to ${MAX_HASHTAGS} or fewer.`,
      });
    }
    if (caption.length > MAX_CAPTION_LENGTH) {
      checks.push({
        level: "warn",
        code: "CAPTION_TOO_LONG",
        message: `The caption is ${caption.length} characters. Instagram truncates at ${MAX_CAPTION_LENGTH}.`,
      });
    }

    if (additions.length === 0) {
      return { final: caption, additions, checks };
    }
    return {
      final: `${caption}\n${additions.join("\n")}`,
      additions,
      checks,
    };
  }

  // No caption at all: the UI shows the lines to add ("Add to your caption:
  // Comment to pre-order! #LM02"). An already-published post has nothing to
  // add — the hashtag scope only matters for the next-post binder.
  if (!alreadyPublished) {
    checks.push({
      level: "warn",
      code: "CTA_MISSING",
      message: "No caption yet. Add the call to action to your post.",
    });
    additions.push(cta);
    if (facts.hashtag) {
      checks.push({
        level: "warn",
        code: "REFERENCE_MISSING",
        message: `No caption yet. Add ${facts.hashtag} so the campaign binds to the post.`,
      });
      additions.push(facts.hashtag);
    }
  }

  return { final: null, additions, checks };
}
