import { z } from "zod";
import { claimCopyItems } from "@/lib/copywriter/service";
import {
  copywriterErrorResponse,
  copywriterJson,
  requireCopywriterBridge,
} from "@/lib/copywriter/http";

const bodySchema = z.object({
  workerId: z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9._-]+$/),
  limit: z.number().int().min(1).max(5),
});

// The worker long-polls; the app holds the request while re-checking the
// queue every second, then answers an empty list. COPYWRITER_CLAIM_MAX_WAIT_MS
// exists for tests; production keeps the 20 s contract.
const DEFAULT_MAX_WAIT_MS = 20_000;
const RECHECK_MS = 1000;

function maxWaitMs(): number {
  const parsed = Number.parseInt(
    process.env.COPYWRITER_CLAIM_MAX_WAIT_MS ?? "",
    10
  );
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MAX_WAIT_MS;
  return Math.min(parsed, DEFAULT_MAX_WAIT_MS);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function POST(request: Request) {
  const unauthorized = requireCopywriterBridge(request);
  if (unauthorized) return unauthorized;
  try {
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return copywriterJson(
        { success: false, error: "INVALID_REQUEST" },
        { status: 400 }
      );
    }

    const deadline = Date.now() + maxWaitMs();
    for (;;) {
      const items = await claimCopyItems(
        parsed.data.workerId,
        parsed.data.limit
      );
      if (items.length > 0) {
        return copywriterJson({ success: true, data: { items } });
      }
      if (Date.now() + RECHECK_MS > deadline) break;
      await sleep(RECHECK_MS);
    }
    return copywriterJson({ success: true, data: { items: [] } });
  } catch (error) {
    return copywriterErrorResponse(error);
  }
}
