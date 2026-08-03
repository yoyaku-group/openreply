import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "crypto";
import { getEncryptionKeyHex } from "@/lib/env";
import { decryptToken, encryptToken } from "@/lib/meta/oauth";

const DEFAULT_ACCOUNT_USERNAMES = ["yoyaku.fr", "yoyakurecordstore"];
const REDACTED = "[REDACTED]";
const PRIVATE_SCALAR_KEYS = new Set([
  "text",
  "message",
  "title",
  "username",
  "name",
  "url",
  "payload",
]);

export function encryptSavText(plaintext: string): string {
  return encryptToken(plaintext);
}

export function decryptSavText(ciphertext: string): string {
  return decryptToken(ciphertext);
}

/** A keyed fingerprint supports equality checks without enabling offline guesses. */
export function savFingerprint(value: string): string {
  return createHmac("sha256", Buffer.from(getEncryptionKeyHex(), "hex"))
    .update(value, "utf8")
    .digest("hex");
}

export function publicFingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function createOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function tokenHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function isSavBridgeAuthorized(request: Request): boolean {
  const configured = process.env.SAV_BRIDGE_TOKEN;
  const header = request.headers.get("authorization");
  if (!configured || configured.length < 32 || !header?.startsWith("Bearer ")) {
    console.warn("[SAV bridge] authorization mismatch", {
      configured: Boolean(configured && configured.length >= 32),
      bearerPresented: Boolean(header?.startsWith("Bearer ")),
      presentedFingerprint: header
        ? publicFingerprint(header).slice(0, 12)
        : null,
    });
    return false;
  }

  const supplied = header.slice("Bearer ".length);
  // Compare fixed-length digests so a wrong credential's length does not
  // change the comparison path.
  const expectedBuffer = createHash("sha256").update(configured).digest();
  const suppliedBuffer = createHash("sha256").update(supplied).digest();
  const valid = timingSafeEqual(expectedBuffer, suppliedBuffer);
  if (!valid) {
    console.warn("[SAV bridge] authorization mismatch", {
      configured: true,
      bearerPresented: true,
      presentedFingerprint: publicFingerprint(supplied).slice(0, 12),
    });
  }
  return valid;
}

export function savAccountKey(username: string): string {
  return username.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

export function getSavAccountUsernames(): Set<string> {
  const configured = process.env.SAV_IG_ACCOUNT_USERNAMES;
  const usernames = configured
    ? configured.split(",").map((value) => value.trim()).filter(Boolean)
    : DEFAULT_ACCOUNT_USERNAMES;
  return new Set(usernames.map((value) => value.toLowerCase()));
}

export function isSavEnabledAccount(username: string): boolean {
  return getSavAccountUsernames().has(username.toLowerCase());
}

/**
 * Webhook rows are an operational audit, not a message archive. Recursively
 * remove customer-authored content and attachment metadata before persistence.
 */
export function redactWebhookPayload(value: unknown, key?: string): unknown {
  if (key === "attachments" && Array.isArray(value)) {
    return { redacted: true, count: value.length };
  }
  if (key && PRIVATE_SCALAR_KEYS.has(key) && typeof value === "string") {
    return REDACTED;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactWebhookPayload(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactWebhookPayload(entryValue, entryKey),
      ])
    );
  }
  return value;
}

export function sanitizeFailureCode(value: unknown): string {
  const normalized = String(value ?? "UNKNOWN")
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, "_")
    .slice(0, 80);
  return normalized || "UNKNOWN";
}
