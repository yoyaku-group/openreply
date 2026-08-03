import { getSavBridgeHealth } from "@/lib/sav/service";
import {
  requireSavBridge,
  savErrorResponse,
  savJson,
} from "@/lib/sav/http";

export async function GET(request: Request) {
  const unauthorized = requireSavBridge(request);
  if (unauthorized) return unauthorized;
  try {
    return savJson({ success: true, data: await getSavBridgeHealth() });
  } catch (error) {
    return savErrorResponse(error);
  }
}
