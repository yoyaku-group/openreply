import { createHmac, timingSafeEqual } from "crypto";

export interface MetaSignedRequestPayload {
  algorithm: "HMAC-SHA256";
  userId: string;
  issuedAt: number | null;
}

interface RawMetaSignedRequestPayload {
  algorithm?: unknown;
  user_id?: unknown;
  issued_at?: unknown;
}

function configuredSecrets(): string[] {
  return [process.env.FACEBOOK_APP_SECRET, process.env.INSTAGRAM_APP_SECRET]
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index);
}

function signaturesMatch(actual: Buffer, expected: Buffer): boolean {
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Verify Meta's `signature.payload` contract without logging either value. */
export function verifyMetaSignedRequest(
  signedRequest: string,
): MetaSignedRequestPayload | null {
  const separator = signedRequest.indexOf(".");
  if (separator <= 0 || separator === signedRequest.length - 1) return null;

  const encodedSignature = signedRequest.slice(0, separator);
  const encodedPayload = signedRequest.slice(separator + 1);

  let signature: Buffer;
  let payload: RawMetaSignedRequestPayload;
  try {
    signature = Buffer.from(encodedSignature, "base64url");
    payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as RawMetaSignedRequestPayload;
  } catch {
    return null;
  }

  if (
    payload.algorithm !== "HMAC-SHA256" ||
    typeof payload.user_id !== "string" ||
    payload.user_id.length === 0
  ) {
    return null;
  }

  const verified = configuredSecrets().some((secret) => {
    const expected = createHmac("sha256", secret)
      .update(encodedPayload)
      .digest();
    return signaturesMatch(signature, expected);
  });
  if (!verified) return null;

  return {
    algorithm: "HMAC-SHA256",
    userId: payload.user_id,
    issuedAt:
      typeof payload.issued_at === "number" ? payload.issued_at : null,
  };
}

export async function readMetaSignedRequest(
  request: Request,
): Promise<{ signedRequest: string; payload: MetaSignedRequestPayload } | null> {
  const contentType = request.headers.get("content-type") ?? "";
  let signedRequest: unknown;

  try {
    if (contentType.includes("application/json")) {
      const body = (await request.json()) as Record<string, unknown>;
      signedRequest = body.signed_request;
    } else {
      const body = await request.formData();
      signedRequest = body.get("signed_request");
    }
  } catch {
    return null;
  }

  if (typeof signedRequest !== "string") return null;
  const payload = verifyMetaSignedRequest(signedRequest);
  return payload ? { signedRequest, payload } : null;
}
