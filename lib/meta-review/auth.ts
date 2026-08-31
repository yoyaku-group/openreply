import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import type Redis from "ioredis";

const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const RATE_LIMIT_WINDOW_SECONDS = 15 * 60;
const RATE_LIMIT_PER_IP = 5;
const RATE_LIMIT_GLOBAL = 100;

export interface MetaReviewerConfig {
  email: string;
  expiresAt: Date;
  host: string;
  passwordHash: string;
  workspaceId: string;
}

type Environment = Record<string, string | undefined>;

function normalizedHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

export function readMetaReviewerConfig(
  env: Environment = process.env,
  now = new Date(),
): MetaReviewerConfig | null {
  if (env.META_REVIEWER_AUTH_ENABLED !== "true") return null;

  const email = env.META_REVIEWER_EMAIL?.trim().toLowerCase();
  const host = env.META_REVIEWER_HOST
    ? normalizedHost(env.META_REVIEWER_HOST)
    : "";
  const passwordHash = env.META_REVIEWER_PASSWORD_SCRYPT?.trim();
  const workspaceId = env.META_REVIEWER_WORKSPACE_ID?.trim();
  const expiresAt = new Date(env.META_REVIEWER_EXPIRES_AT ?? "");
  if (
    !email ||
    !host ||
    !passwordHash ||
    !workspaceId ||
    Number.isNaN(expiresAt.getTime()) ||
    expiresAt <= now
  ) {
    return null;
  }

  return { email, expiresAt, host, passwordHash, workspaceId };
}

export function requestHost(value: string | null): string {
  if (!value) return "";
  const first = value.split(",", 1)[0]?.trim().toLowerCase() ?? "";
  return normalizedHost(first.replace(/:\d+$/, ""));
}

export function createMetaReviewerPasswordHash(
  password: string,
  salt = randomBytes(24),
): string {
  const cost = 32768;
  const blockSize = 8;
  const parallelization = 1;
  const digest = scryptSync(password, salt, SCRYPT_KEY_LENGTH, {
    N: cost,
    r: blockSize,
    p: parallelization,
    maxmem: SCRYPT_MAX_MEMORY,
  });
  return [
    "scrypt",
    cost,
    blockSize,
    parallelization,
    salt.toString("base64url"),
    digest.toString("base64url"),
  ].join("$");
}

export function verifyMetaReviewerPassword(
  password: string,
  encodedHash: string,
): boolean {
  try {
    const [algorithm, rawN, rawR, rawP, rawSalt, rawDigest] =
      encodedHash.split("$");
    if (algorithm !== "scrypt" || !rawSalt || !rawDigest) return false;
    const N = Number(rawN);
    const r = Number(rawR);
    const p = Number(rawP);
    if (N !== 32768 || r !== 8 || p !== 1) return false;
    const expected = Buffer.from(rawDigest, "base64url");
    if (expected.length !== SCRYPT_KEY_LENGTH) return false;
    const actual = scryptSync(
      password,
      Buffer.from(rawSalt, "base64url"),
      expected.length,
      {
        N,
        r,
        p,
        maxmem: SCRYPT_MAX_MEMORY,
      },
    );
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function rateLimitKeys(ip: string): { global: string; ip: string } {
  const ipHash = createHash("sha256")
    .update(ip || "unknown")
    .digest("hex");
  return {
    global: "meta-review:auth:failures:global",
    ip: `meta-review:auth:failures:ip:${ipHash}`,
  };
}

export async function isMetaReviewerRateLimited(
  redis: Redis,
  ip: string,
): Promise<boolean> {
  const keys = rateLimitKeys(ip);
  const [ipFailures, globalFailures] = await Promise.all([
    redis.get(keys.ip),
    redis.get(keys.global),
  ]);
  return (
    Number(ipFailures ?? 0) >= RATE_LIMIT_PER_IP ||
    Number(globalFailures ?? 0) >= RATE_LIMIT_GLOBAL
  );
}

export async function recordMetaReviewerFailure(
  redis: Redis,
  ip: string,
): Promise<void> {
  const keys = rateLimitKeys(ip);
  await Promise.all(
    [keys.ip, keys.global].map(async (key) => {
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, RATE_LIMIT_WINDOW_SECONDS);
    }),
  );
}

export async function clearMetaReviewerIpFailures(
  redis: Redis,
  ip: string,
): Promise<void> {
  await redis.del(rateLimitKeys(ip).ip);
}

export function reviewerSessionExpiry(
  reviewerExpiresAt: Date,
  now = new Date(),
): Date {
  return new Date(
    Math.min(reviewerExpiresAt.getTime(), now.getTime() + 8 * 60 * 60 * 1000),
  );
}

export function newReviewerSessionToken(): string {
  return randomBytes(32).toString("hex");
}
