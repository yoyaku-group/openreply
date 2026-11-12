import { z } from "zod";
import { submitCopyFailure } from "@/lib/copywriter/service";
import {
  copywriterErrorResponse,
  copywriterJson,
  requireCopywriterBridge,
} from "@/lib/copywriter/http";

const bodySchema = z.object({
  workerId: z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9._-]+$/),
  // Machine-readable code only. The worker never ships provider details:
  // stderr can name tiers, keys and quotas.
  code: z.string().max(200).optional(),
});

type RouteProps = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: RouteProps) {
  const unauthorized = requireCopywriterBridge(request);
  if (unauthorized) return unauthorized;
  try {
    const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return copywriterJson(
        { success: false, error: "INVALID_REQUEST" },
        { status: 400 }
      );
    }
    const { id } = await params;
    await submitCopyFailure(id, parsed.data.workerId, parsed.data.code);
    return copywriterJson({ success: true });
  } catch (error) {
    return copywriterErrorResponse(error);
  }
}
