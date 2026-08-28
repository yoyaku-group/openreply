import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  getEncryptionKeyHex,
  getMetaGraphApiVersion,
  getRequestBaseUrl,
  requireEnv,
} from "../lib/env";

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe("environment helpers", () => {
  it("requires missing variables", () => {
    expect(() => requireEnv("MISSING_TEST_ENV")).toThrow(
      "MISSING_TEST_ENV environment variable is required"
    );
  });

  it("validates the encryption key format", () => {
    vi.stubEnv("ENCRYPTION_KEY", "not-hex");
    expect(() => getEncryptionKeyHex()).toThrow(
      "ENCRYPTION_KEY must be a 32-byte hex string"
    );
  });

  it("defaults Meta Graph API version in one place", () => {
    expect(getMetaGraphApiVersion()).toBe("v25.0");
    vi.stubEnv("META_GRAPH_API_VERSION", "v26.0");
    expect(getMetaGraphApiVersion()).toBe("v26.0");
  });

  it("uses only allowlisted request hosts for OAuth callbacks", () => {
    vi.stubEnv("NEXTAUTH_URL", "https://openreply.yoyaku.fr");
    vi.stubEnv(
      "OPENREPLY_ALLOWED_HOSTS",
      "openreply.yoyaku.fr,openreply.objects.press"
    );
    expect(
      getRequestBaseUrl({ nextUrl: new URL("https://openreply.objects.press/settings") })
    ).toBe("https://openreply.objects.press");
    expect(
      getRequestBaseUrl({ nextUrl: new URL("https://attacker.example/settings") })
    ).toBe("https://openreply.yoyaku.fr");
  });
});
