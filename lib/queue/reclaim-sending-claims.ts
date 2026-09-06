import { prisma } from "@/lib/db/client";

// A worker hard-crash (SIGKILL/OOM/host failure) between the P1-2b atomic
// PENDING->SENDING claim and a terminal status can strand a DmLog row in
// SENDING. Because SENDING is in the reserved set of the partial unique index
// DmLog_reservation_unique, a stuck SENDING row permanently blocks that
// commenter on that media (every later comment -> P2002 -> SKIPPED_DEDUP).
// BullMQ stalled-job recovery self-heals most crashes (the retry re-claims the
// row), so this reaper only catches the residual where the job is lost entirely.
//
// Reclaim to FAILED, never PENDING: we cannot know whether the Meta send
// actually completed before the crash, and P1-2b deliberately errs toward
// under-send over double-send. FAILED clears the reservation without resending;
// the commenter's next comment can re-trigger cleanly.
//
// The threshold must be >> the send window (seconds) and >> BullMQ's job
// lock/stall timeout, so an in-flight claim from a live worker (whose updatedAt
// is refreshed on every retry) is never reset. Default 15 min is far above both.
const STALE_SENDING_RECLAIM_MS = Number(
  process.env.STALE_SENDING_RECLAIM_MS ?? 15 * 60_000
);

/**
 * Reset DmLog rows stuck in SENDING past the staleness threshold to FAILED.
 * Returns the number of rows reclaimed. Safe to run periodically and at boot.
 */
export async function reclaimStaleSendingClaims(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_SENDING_RECLAIM_MS);
  const result = await prisma.dmLog.updateMany({
    where: {
      status: "SENDING",
      updatedAt: { lt: cutoff },
    },
    data: {
      status: "FAILED",
      errorMessage:
        "Reclaimed: SENDING claim went stale (worker crash between claim and send). No DM sent; the commenter can re-trigger on a new comment.",
    },
  });
  return result.count;
}
