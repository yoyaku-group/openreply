import { preflightSavItem } from "@/lib/sav/service";
import {
  requireSavBridge,
  savErrorResponse,
  savJson,
} from "@/lib/sav/http";

type RouteProps = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: RouteProps) {
  const unauthorized = requireSavBridge(request);
  if (unauthorized) return unauthorized;
  try {
    const { id } = await params;
    return savJson({ success: true, data: await preflightSavItem(id) });
  } catch (error) {
    return savErrorResponse(error);
  }
}
