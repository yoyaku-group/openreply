/**
 * Character-level Levenshtein distance over the four DM copy fields.
 *
 * Recorded on save from the assistant (CopyGeneration.editDistance) so lot S4
 * can measure how far the team's validated copy drifted from what the model
 * wrote. Pure and dependency-free.
 */

export interface CopyTexts {
  /** Opening DM; null when the campaign has no opening step. */
  openingDm: string | null;
  openingButton: string | null;
  revealDm: string;
  linkButton: string;
}

/** Classic dynamic-programming Levenshtein, O(len(a) * len(b)) memory-light. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        substitution,
      );
    }
    previous = current;
  }
  return previous[b.length];
}

function fieldDistance(a: string | null, b: string | null): number {
  return levenshtein(a ?? "", b ?? "");
}

/** Total distance across the four fields, in characters. */
export function copyEditDistance(a: CopyTexts, b: CopyTexts): number {
  return (
    fieldDistance(a.openingDm, b.openingDm) +
    fieldDistance(a.openingButton, b.openingButton) +
    fieldDistance(a.revealDm, b.revealDm) +
    fieldDistance(a.linkButton, b.linkButton)
  );
}
