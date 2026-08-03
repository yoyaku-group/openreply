import { z } from "zod";
import { holdSavItem } from "@/lib/sav/service";
import {
  requireSavBridge,
  savErrorResponse,
  savJson,
} from "@/lib/sav/http";

const bodySchema = z.object({
  claimToken: z.string().min(32).max(200).optional(),
  reason: z.string().max(200).optional(),
});
type RouteProps = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: RouteProps) {
  const unauthorized = requireSavBridge(request);
  if (unauthorized) return unauthorized;
  try {
    const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return savJson({ success: false, error: "INVALID_REQUEST" }, { status: 400 });
    }
    const { id } = await params;
    await holdSavItem(id, parsed.data.claimToken, parsed.data.reason);
    return savJson({ success: true });
  } catch (error) {
    return savErrorResponse(error);
  }
}
