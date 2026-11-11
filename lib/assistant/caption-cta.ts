import type { ProductState } from "@/lib/assistant/resolve-product";

/**
 * Caption call to action per product state (automation playbook house style:
 * one catalogue reference per caption, the CTA tells the commenter what to
 * do). One constant, so the wording is validated in a single place; the owner
 * signs off on the strings at review.
 */
export const CTA_BY_STATE: Record<ProductState, string> = {
  preorder: "Comment to pre-order!",
  coming_soon: "Comment to get the link!",
  restock: "Comment to get the link!",
  available: "Comment to get the link!",
};

/** The caption CTA for a product state. */
export function ctaFor(state: ProductState): string {
  return CTA_BY_STATE[state] ?? CTA_BY_STATE.available;
}
