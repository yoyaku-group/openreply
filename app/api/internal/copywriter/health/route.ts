import { getCopywriterHealth } from "@/lib/copywriter/service";
import {
  copywriterErrorResponse,
  copywriterJson,
  requireCopywriterBridge,
} from "@/lib/copywriter/http";

export async function GET(request: Request) {
  const unauthorized = requireCopywriterBridge(request);
  if (unauthorized) return unauthorized;
  try {
    return copywriterJson({ success: true, data: await getCopywriterHealth() });
  } catch (error) {
    return copywriterErrorResponse(error);
  }
}
