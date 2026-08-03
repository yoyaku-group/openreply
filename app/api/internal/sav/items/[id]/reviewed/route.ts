import { z } from "zod";
import { markSavItemReviewed } from "@/lib/sav/service";
import {
  requireSavBridge,
  savErrorResponse,
  savJson,
} from "@/lib/sav/http";

const bodySchema = z.object({ claimToken: z.string().min(32).max(200) });
type RouteProps = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: RouteProps) {
  const unauthorized = requireSavBridge(request);
  if (unauthorized) return unauthorized;
  try {
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return savJson({ success: false, error: "INVALID_REQUEST" }, { status: 400 });
    }
    const { id } = await params;
    await markSavItemReviewed(id, parsed.data.claimToken);
    return savJson({ success: true });
  } catch (error) {
    return savErrorResponse(error);
  }
}
