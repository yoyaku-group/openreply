import { z } from "zod";
import { claimSavItems } from "@/lib/sav/service";
import {
  requireSavBridge,
  savErrorResponse,
  savJson,
} from "@/lib/sav/http";

const bodySchema = z.object({
  workerId: z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9._-]+$/),
  limit: z.number().int().min(1).max(20),
  accountKeys: z
    .array(z.enum(["yoyaku_fr", "yoyakurecordstore"]))
    .min(1)
    .max(2)
    .optional(),
});

export async function POST(request: Request) {
  const unauthorized = requireSavBridge(request);
  if (unauthorized) return unauthorized;
  try {
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return savJson({ success: false, error: "INVALID_REQUEST" }, { status: 400 });
    }
    const items = await claimSavItems(
      parsed.data.workerId,
      parsed.data.limit,
      parsed.data.accountKeys
    );
    return savJson({ success: true, data: { items } });
  } catch (error) {
    return savErrorResponse(error);
  }
}
