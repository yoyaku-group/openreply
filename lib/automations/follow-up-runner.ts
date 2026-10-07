/**
 * follow-up-runner — the single ~20h follow-up job (plan delegated-roaming-turing
 * F). DORMANT unless FOLLOW_UP_REMINDER_ENABLED=1. The prisma client and the
 * send are injected so the orchestration is tested without a network.
 *
 * Targets only people who tapped the tracked link (see selectFollowUpRecipients
 * — that tap is what opens Instagram's 24h window). At most ONE follow-up per
 * dmLog, recorded as followUpSentAt.
 */

import { selectFollowUpRecipients } from "./follow-up";

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

type MinimalPrisma = {
  dmLog: {
    findMany: (args: unknown) => Promise<Array<{ id: string; status: string; commenterId: string; createdAt: Date }>>;
    update: (args: unknown) => Promise<unknown>;
  };
  linkClick: {
    findMany: (args: unknown) => Promise<Array<{ dmLogId: string | null }>>;
  };
};

export function isFollowUpEnabled(): boolean {
  return String(process.env.FOLLOW_UP_REMINDER_ENABLED ?? "").trim() === "1";
}

export async function runFollowUps(input: {
  prisma: MinimalPrisma;
  send: (dmLogId: string) => Promise<unknown>;
  nowMs?: number;
  windowMs?: number;
  limit?: number;
  force?: boolean;
}): Promise<{ enabled: boolean; sent: number; candidates: number }> {
  const {
    prisma,
    send,
    nowMs = Date.now(),
    windowMs = DEFAULT_WINDOW_MS,
    limit = 50,
    force = false,
  } = input;

  if (!force && !isFollowUpEnabled()) return { enabled: false, sent: 0, candidates: 0 };

  const since = new Date(nowMs - windowMs);
  const dmLogs = await prisma.dmLog.findMany({
    where: { status: "SENT", followUpSentAt: null, createdAt: { gte: since } },
    select: { id: true, status: true, commenterId: true, createdAt: true },
    take: limit * 2,
  });
  if (dmLogs.length === 0) return { enabled: true, sent: 0, candidates: 0 };

  const clicks = await prisma.linkClick.findMany({
    where: { dmLogId: { in: dmLogs.map((d) => d.id) } },
    select: { dmLogId: true },
  });

  const recipients = selectFollowUpRecipients({ dmLogs, linkClicks: clicks, nowMs, windowMs });

  let sent = 0;
  for (const r of recipients.slice(0, limit)) {
    try {
      await send(r.dmLogId);
      await prisma.dmLog.update({ where: { id: r.dmLogId }, data: { followUpSentAt: new Date(nowMs) } });
      sent += 1;
    } catch {
      // Best-effort per recipient; the others still go out.
    }
  }
  return { enabled: true, sent, candidates: recipients.length };
}
