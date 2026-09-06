import { prisma } from "@/lib/db/client";

// A worker hard-crash (SIGKILL/OOM/host failure) between the P1-2b atomic
// PENDING->SENDING claim and a terminal status can strand a DmLog row in
// SENDING. Because SENDING is in the reserved set of the partial unique index
// DmLog_reservation_unique, a stuck SENDING row permanently blocks that
// commenter on that media (every later comment -> P2002 -> SKIPPED_DEDUP).
// BullMQ stalled-job recovery self-heals most crashes (the retry re-claims the
// row); this reaper catches the residual where the job is lost entirely.
//
// Reclaim to FAILED, never PENDING: we cannot know whether the Meta send
// completed before the crash, and P1-2b deliberately errs toward under-send over
// double-send. FAILED clears the reservation without resending; the commenter's
// next comment can re-trigger cleanly.

// Absolute floor so a previous instance still gracefully draining a job at a
// rolling handoff is never reclaimed out from under it. Parsed defensively: an
// empty string ("") — a common .env/orchestration misconfig — makes Number("")
// return 0, which would collapse the cutoff to "now" and sweep live claims, so
// anything not a positive finite number falls back to the default.
function parsePositiveMs(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const STALE_SENDING_RECLAIM_MS = parsePositiveMs(
  process.env.STALE_SENDING_RECLAIM_MS,
  15 * 60_000
);

/**
 * Reset DmLog rows stuck in SENDING to FAILED, returning the number reclaimed.
 * A row is reclaimed only when BOTH hold:
 *   1. it was claimed before this worker instance booted — so it belongs to a
 *      previous (crashed/replaced) instance. A live in-flight send in THIS
 *      process is always newer than boot and is therefore never swept, which is
 *      what keeps the reaper from reopening P1-2b's double-send window (a
 *      slow-but-alive send is left to BullMQ's stall/retry domain, not reaped);
 *   2. it is older than the absolute floor (STALE_SENDING_RECLAIM_MS).
 * Safe to run periodically and at boot.
 */
export async function reclaimStaleSendingClaims(
  workerStartedAt: Date
): Promise<number> {
  const floor = new Date(Date.now() - STALE_SENDING_RECLAIM_MS);
  const result = await prisma.dmLog.updateMany({
    where: {
      status: "SENDING",
      AND: [
        { updatedAt: { lt: workerStartedAt } },
        { updatedAt: { lt: floor } },
      ],
    },
    data: {
      status: "FAILED",
      errorMessage:
        "Reclaimed: SENDING claim orphaned by a previous worker instance (crash between claim and send). No DM sent; the commenter can re-trigger on a new comment.",
    },
  });
  return result.count;
}
