/**
 * follow-up — the single ~20h reminder after a pre-order DM (plan
 * delegated-roaming-turing F).
 *
 * Only a person who actually tapped the tracked link can be followed up: that
 * tap is what opens Instagram's 24h messaging window. Someone who commented but
 * never tapped the button cannot be re-messaged (one DM per comment), so they
 * are never selected. At most ONE follow-up per dmLog.
 *
 * Pure: the caller supplies the dmLogs + link clicks; selection has no I/O.
 */

export type FollowUpDmLog = {
  id: string;
  status: string;
  commenterId: string;
  createdAt: Date | string | null;
};

export type FollowUpLinkClick = { dmLogId: string | null };

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

export function selectFollowUpRecipients(input: {
  dmLogs?: FollowUpDmLog[];
  linkClicks?: FollowUpLinkClick[];
  nowMs: number;
  windowMs?: number;
  followedUpIds?: Set<string>;
}): { dmLogId: string; commenterId: string }[] {
  const {
    dmLogs = [],
    linkClicks = [],
    nowMs,
    windowMs = DEFAULT_WINDOW_MS,
    followedUpIds = new Set<string>(),
  } = input;

  const clicked = new Set<string>();
  for (const c of linkClicks) {
    if (c && c.dmLogId) clicked.add(c.dmLogId);
  }

  const out: { dmLogId: string; commenterId: string }[] = [];
  for (const d of dmLogs) {
    if (!d || d.status !== "SENT") continue;
    if (followedUpIds.has(d.id)) continue;
    if (!clicked.has(d.id)) continue; // never tapped -> outside the 24h window
    const t = d.createdAt ? Date.parse(String(d.createdAt)) : NaN;
    if (
      Number.isFinite(t) &&
      Number.isFinite(nowMs) &&
      nowMs - t > windowMs
    ) {
      continue; // window closed
    }
    out.push({ dmLogId: d.id, commenterId: d.commenterId });
  }
  return out;
}
