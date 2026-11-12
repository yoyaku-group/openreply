/**
 * Word-level diff for the prompt lab (lot S4).
 *
 * The lab shows, per copy field, what the team changed between the AI output
 * and the validated `finalCopy`. Pure, dependency-free (house rule: no new
 * dependency for a small pure helper). LCS dynamic programming over word
 * tokens; the four DM fields are at most a few hundred characters, so the
 * O(len(a)*len(b)) table is trivially small.
 */

export type DiffOp = "equal" | "add" | "remove";

export interface DiffToken {
  op: DiffOp;
  value: string;
}

const WORD_RE = /\S+/g;

function tokenize(text: string): string[] {
  return text.match(WORD_RE) ?? [];
}

/**
 * Word-level diff: `a` is the old side (AI output), `b` the new side (the
 * copy the team validated). Words only in `b` are "add", only in `a` are
 * "remove", shared words are "equal". Adjacent same-op tokens are merged so
 * the UI renders one span per contiguous change.
 */
export function wordDiff(a: string, b: string): DiffToken[] {
  const left = tokenize(a);
  const right = tokenize(b);
  const n = left.length;
  const m = right.length;

  // LCS lengths table.
  const table: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0)
  );
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] =
        left[i] === right[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const raw: DiffToken[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (left[i] === right[j]) {
      raw.push({ op: "equal", value: left[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      raw.push({ op: "remove", value: left[i] });
      i += 1;
    } else {
      raw.push({ op: "add", value: right[j] });
      j += 1;
    }
  }
  while (i < n) {
    raw.push({ op: "remove", value: left[i] });
    i += 1;
  }
  while (j < m) {
    raw.push({ op: "add", value: right[j] });
    j += 1;
  }

  // Merge contiguous tokens of the same op; words join with spaces.
  const merged: DiffToken[] = [];
  for (const token of raw) {
    const last = merged[merged.length - 1];
    if (last && last.op === token.op) {
      last.value = `${last.value} ${token.value}`;
    } else {
      merged.push({ ...token });
    }
  }
  return merged;
}

/** True when the two texts use the same words in the same order. */
export function isWordDiffEmpty(a: string, b: string): boolean {
  return wordDiff(a, b).every((token) => token.op === "equal");
}
