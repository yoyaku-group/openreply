import { createHash, timingSafeEqual } from "crypto";
import { publicFingerprint } from "@/lib/sav/security";

/**
 * Authorization for the internal copywriter bridge (`COPYWRITER_BRIDGE_TOKEN`),
 * mirroring `isSavBridgeAuthorized`: fail closed when the token is absent or
 * shorter than 32 bytes, compare fixed-length digests so a wrong credential's
 * length never changes the timing path, and log only boolean metadata plus a
 * short fingerprint — never either token.
 */
export function isCopywriterBridgeAuthorized(request: Request): boolean {
  const configured = process.env.COPYWRITER_BRIDGE_TOKEN;
  const header = request.headers.get("authorization");
  if (!configured || configured.length < 32 || !header?.startsWith("Bearer ")) {
    console.warn("[copywriter bridge] authorization mismatch", {
      configured: Boolean(configured && configured.length >= 32),
      bearerPresented: Boolean(header?.startsWith("Bearer ")),
      presentedFingerprint: header
        ? publicFingerprint(header).slice(0, 12)
        : null,
    });
    return false;
  }

  const supplied = header.slice("Bearer ".length);
  const expectedBuffer = createHash("sha256").update(configured).digest();
  const suppliedBuffer = createHash("sha256").update(supplied).digest();
  const valid = timingSafeEqual(expectedBuffer, suppliedBuffer);
  if (!valid) {
    console.warn("[copywriter bridge] authorization mismatch", {
      configured: true,
      bearerPresented: true,
      presentedFingerprint: publicFingerprint(supplied).slice(0, 12),
    });
  }
  return valid;
}
