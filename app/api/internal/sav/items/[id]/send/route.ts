import { z } from "zod";
import { sendSavReply } from "@/lib/sav/service";
import {
  requireSavBridge,
  savErrorResponse,
  savJson,
} from "@/lib/sav/http";

const bodySchema = z.object({
  deliveryToken: z.string().min(32).max(200),
  idempotencyKey: z.string().trim().min(8).max(200).regex(/^[a-zA-Z0-9._:-]+$/),
  text: z.string().trim().min(1).max(1000),
});
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
    return savJson({
      success: true,
      data: await sendSavReply({ id, ...parsed.data }),
    });
  } catch (error) {
    return savErrorResponse(error);
  }
}
