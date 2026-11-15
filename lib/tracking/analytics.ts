const SKIPPED_PREFIX = "SKIPPED_";

export interface StatusCountRow {
  status: string;
  _count: number | { status?: number; _all?: number };
}

export interface KeywordCountRow {
  matchedKeyword: string | null;
  _count: number | { matchedKeyword?: number; _all?: number };
}

function getCount(value: StatusCountRow["_count"] | KeywordCountRow["_count"]) {
  if (typeof value === "number") return value;
  if ("status" in value && typeof value.status === "number") {
    return value.status;
  }
  if ("matchedKeyword" in value && typeof value.matchedKeyword === "number") {
    return value.matchedKeyword;
  }
  return value._all ?? 0;
}

/**
 * Click-through rate: the share of delivered DMs that produced at least one
 * click. Raw clicks are deliberately NOT the numerator — a single person can
 * click a link five times (link previews, re-opens) and a click/sent ratio
 * above 1 is meaningless as a rate. Returns `null` when nothing was sent:
 * "no data yet" is not the same statement as "0% clicked", and callers render
 * it as "unknown" rather than a misleading zero.
 */
export function calculateCtr(uniqueClickers: number, sent: number) {
  if (sent <= 0) return null;
  return Number((uniqueClickers / sent).toFixed(3));
}

/** Same rate as a percentage, for display. `null` stays "unknown". */
export function formatCtr(rate: number | null): string {
  return rate === null ? "unknown" : `${Number((rate * 100).toFixed(1))}%`;
}

/** One row of a `linkClick.groupBy({ by: ["dmLogId"] })` result. */
export interface ClickerRow {
  dmLogId: string | null;
}

/**
 * Turn raw click counts plus the distinct-DM groups into the three numbers the
 * dashboards report: raw clicks (traffic, repeat opens included), unique
 * clickers (distinct DMs clicked at least once) and the click rate computed
 * from the latter. Grouping happens in SQL — this only counts the groups.
 */
export function summarizeClicks(
  clicks: number,
  clickerRows: ClickerRow[],
  sent: number
) {
  // A group can only exist for a non-null dmLogId (callers filter), but a null
  // key would mean "clicks we cannot attribute" and must not inflate the rate.
  const uniqueClickers = clickerRows.filter(
    (row) => row.dmLogId !== null
  ).length;
  return {
    clicks,
    uniqueClickers,
    ctr: calculateCtr(uniqueClickers, sent),
  };
}

export function summarizeDmStatuses(rows: StatusCountRow[]) {
  return rows.reduce(
    (summary, row) => {
      const count = getCount(row._count);
      if (row.status === "SENT") summary.sent += count;
      if (row.status === "FAILED") summary.failed += count;
      if (row.status.startsWith(SKIPPED_PREFIX)) summary.skipped += count;
      return summary;
    },
    { sent: 0, skipped: 0, failed: 0 }
  );
}

export function normalizeTopKeywords(rows: KeywordCountRow[], limit = 5) {
  return rows
    .filter((row) => row.matchedKeyword)
    .map((row) => ({
      keyword: row.matchedKeyword as string,
      count: getCount(row._count),
    }))
    .sort((a, b) => b.count - a.count || a.keyword.localeCompare(b.keyword))
    .slice(0, limit);
}
