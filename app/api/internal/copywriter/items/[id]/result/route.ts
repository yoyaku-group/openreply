import { z } from "zod";
import { submitCopyResult } from "@/lib/copywriter/service";
import {
  copywriterErrorResponse,
  copywriterJson,
  requireCopywriterBridge,
} from "@/lib/copywriter/http";

const bodySchema = z.object({
  workerId: z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9._-]+$/),
  rawOutput: z.string().max(100_000),
  tier: z.string().max(100).nullable().optional(),
  latencyMs: z.number().int().min(0).max(10 * 60 * 1000).nullable().optional(),
});

type RouteProps = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: RouteProps) {
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
    const { id } = await params;
    const outcome = await submitCopyResult(id, parsed.data.workerId, {
      rawOutput: parsed.data.rawOutput,
      tier: parsed.data.tier ?? null,
      latencyMs: parsed.data.latencyMs ?? null,
    });
    return copywriterJson({ success: true, data: outcome });
  } catch (error) {
    return copywriterErrorResponse(error);
  }
}
